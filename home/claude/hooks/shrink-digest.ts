#!/usr/bin/env bun
// Stop hook: append a trimmed "digest" of a verbose assistant answer.
//
// Over-inclusion is only reduced by a post-edit cut pass (see vault experiments
// 2026-06-23-agentsmd-rule-conformance-differential + -messagedisplay-cut-hook-spike).
// Hooks cannot rewrite a streamed message and cannot print to the terminal, so
// this reads the finished answer (`last_assistant_message`), drops out-of-scope
// BLOCKS via a fast Fireworks model, reconstructs survivors VERBATIM, and returns
// the result as `systemMessage` — a digest shown below the full answer. The
// answer itself is never touched. Any failure -> exit 0, no digest.
//
// Runs under `doppler run` so FIREWORKS_API_KEY is in the env. Size-gated so
// short answers cost nothing past startup.
const MODEL = "accounts/fireworks/models/gpt-oss-120b";
const GATE_WORDS = 140; // below this, no digest
const FW_TIMEOUT_MS = 8000;

const bail = () => process.exit(0); // emit nothing -> no digest, answer untouched
const wc = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

// Fence-aware split: blank lines separate blocks, but ``` code fences stay whole.
function splitBlocks(text: string): string[] {
  const lines = text.split("\n");
  const blocks: string[] = [];
  let cur: string[] = [],
    fence = false;
  const flush = () => {
    if (cur.join("\n").trim()) blocks.push(cur.join("\n"));
    cur = [];
  };
  for (const ln of lines) {
    if (/^\s*```/.test(ln)) {
      fence = !fence;
      cur.push(ln);
      continue;
    }
    if (!fence && ln.trim() === "") {
      flush();
      continue;
    }
    cur.push(ln);
  }
  flush();
  return blocks;
}

const raw = await Bun.stdin.text();
let input: any;
try {
  input = JSON.parse(raw);
} catch {
  bail();
}

const original: string = input.last_assistant_message ?? "";
if (!original.trim()) bail();

const words_in = wc(original);
if (words_in < GATE_WORDS) bail(); // gate: short answers get no digest

const blocks = splitBlocks(original);
if (blocks.length < 3) bail();

const isCode = (b: string) => /(^|\n)\s*```/.test(b);
const numbered = blocks
  .map((b, i) => `[${i + 1}]${isCode(b) ? " (contains code)" : ""}\n${b}`)
  .join("\n\n");
const prompt = `You are trimming an assistant answer to the MINIMAL SUFFICIENT response. Below are the answer's blocks, each tagged [n]. Identify the blocks that are OUT OF SCOPE: adjacent topics not asked about, options/alternatives not requested, exhaustive caveats and edge cases, background or tutorials, and repetition. KEEP the direct answer/recommendation and only the facts needed to act on it. Never drop the block that contains the core answer, or a code block needed to act on it. You may drop a code block only when it belongs to an out-of-scope tangent — and then also drop that tangent's surrounding explanation, so no code block is left without its prose (keep or drop a code block together with its explanation as a unit).
Return ONLY strict JSON: {"drop":[n,...]} listing the block numbers to remove. Empty list if nothing is out of scope.

${numbered}`;

let dropIds: number[] = [];
try {
  const resp = await fetch("https://api.fireworks.ai/inference/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.FIREWORKS_API_KEY ?? ""}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024, // reasoning model bills chain-of-thought against this
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(FW_TIMEOUT_MS),
  });
  const j: any = await resp.json();
  const content = j?.choices?.[0]?.message?.content ?? "";
  const m = content.match(/\{[\s\S]*\}/); // tolerate prose around the JSON
  const parsed = JSON.parse(m ? m[0] : content);
  dropIds = Array.isArray(parsed.drop) ? parsed.drop.filter((n: any) => Number.isInteger(n)) : [];
} catch {
  bail();
}

const keep = blocks.filter((_, i) => !dropIds.includes(i + 1));
// Nothing to trim, or model went pathological -> no digest.
if (dropIds.length === 0 || keep.length === 0) bail();

const cut = keep.join("\n\n");
const words_out = wc(cut);
const pct = words_in ? Math.round((1 - words_out / words_in) * 100) : 0;
if (pct < 10) bail(); // not worth a digest if it barely shrank

// The systemMessage note renders raw markdown, so strip formatting symbols.
// Deterministic (content stays verbatim, only markup removed) — the model is
// not asked to rewrite, so no garbling/rephrasing risk.
function stripMd(s: string): string {
  return s
    .split("\n")
    .filter((ln) => !/^\s*```/.test(ln)) // drop code-fence lines, keep the code text
    .map(
      (ln) =>
        ln
          .replace(/^\s*#{1,6}\s+/, "") // headings
          .replace(/^\s*>\s?/, "") // blockquotes
          .replace(/^(\s*)[-*+]\s+/, "$1") // bullet markers
          .replace(/^(\s*)\d+\.\s+/, "$1") // numbered markers
          .replace(/\*\*(.+?)\*\*/g, "$1") // bold **
          .replace(/__(.+?)__/g, "$1") // bold __
          .replace(/(?<![*\w])\*(?!\*)([^*]+?)\*(?!\*)/g, "$1") // italic *
          .replace(/`([^`]+)`/g, "$1") // inline code
          .replace(/\[(.+?)\]\((.+?)\)/g, "$1"), // links -> text
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const digest = `— cut ${pct}% │ ${words_in}→${words_out} words —\n\n${stripMd(cut)}`;
process.stdout.write(JSON.stringify({ systemMessage: digest }));
