#!/usr/bin/env bun
// cut — trim out-of-scope and unnecessary content from text.
//
// Pipeline: segment → editor cut (gpt-oss-120b) → judge grade (glm-5p2:
// load/borderline/surplus) → reconstruct (restore load, drop surplus, drop+flag
// borderline) → revise survivors (gpt-oss-120b, 4 sequential writing passes) → output.
//
// Output: the trimmed text is written to a fresh temp .md file (mktemp), with each
// questionable (borderline) cut appended verbatim below a `---` separator so a parent
// model can splice it back in place. stdout is two lines — the file path, then a
// footer naming the questionable cuts. Failsafe: any error → the temp file holds the
// original text (passthrough), path still printed.
//
// Standalone headless CLI. Generous time budget (~25–40 s). Fireworks via
// FIREWORKS_API_KEY (e.g. `doppler run --project claude-code --config std --`).
//
// Usage:  cut-text < input.txt              # auto-detect language
//         cut-text --lang ru < input.txt    # force Russian rubric
//         cut-text --no-revise < input.txt  # block-cut only, skip word-level revise
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const FW = "https://api.fireworks.ai/inference/v1/chat/completions";
const EDITOR = "accounts/fireworks/models/gpt-oss-120b"; // fast, obedient; ~3 s
const JUDGE = "accounts/fireworks/models/glm-5p2"; // thinking; ~15–20 s, clean content
const TIMEOUT_MS = 180_000;

// ---- embedded writing passes (condensed from writing-en/ru pass 1–4) ----
// Each pass is a separate, focused rule set applied in sequence (words →
// sentences → paragraphs → AI patterns); each call refines the prior pass's
// output. Full reference rules live in reference-en.md / reference-ru.md.
type Pass = { name: string; rules: string };

const PASS_EN: Pass[] = [
  {
    name: "words",
    rules: `WORDS: turn nominalizations (-tion/-ment/-ance) into verbs; prefer the shortest word that means the same; cut filler ("it is important to note", "due to the fact that", "in order to"); use affirmative not negative forms ("is absent" not "is not present"); replace dead metaphors with literal statements; use everyday English over formal/Latin words ("use" not "utilize", "end" not "terminate").`,
  },
  {
    name: "sentences",
    rules: `SENTENCES: make the actor the subject; use active voice; get to the main verb within ~7 words; open with familiar information, close with the new; chain known→new across sentences; keep one topic per sentence; replace verbless fragments ("Fast, but fragile") with a subject+verb; split sentences carrying more than one idea, reconnect with a transition if the ideas depend on each other.`,
  },
  {
    name: "paragraphs",
    rules: `PARAGRAPHS: lead with the main point; keep one topic per paragraph; where headings are used, make them informative (not "Introduction"/"Discussion"), but do not add headings to prose that has none; explain prerequisites before the things that depend on them; keep paragraphs short enough to scan.`,
  },
  {
    name: "ai",
    rules: `AI PATTERNS: cut filler openings ("Here's how", "In this section", "Let's dive in"); replace promotional adjectives (innovative/robust/scalable/seamless) with facts; cut significance inflation ("pivotal moment", "underscores its significance"); restore plain copulas (is/has, not "serves as"/"boasts"/"represents"); cut canned constructions ("not just X but Y", rule-of-three padding); thin out AI vocabulary (delve, underscore, leverage, robust, intricate, tapestry, navigate); vary sentence length.`,
  },
];

const PASS_RU: Pass[] = [
  {
    name: "words",
    rules: `СЛОВА: отглагольные существительные (-ание/-ение/-ция) → глаголы; выбирай короткое слово; убирай мусор («следует отметить», «ввиду того что», «в принципе», «таким образом»); утверждение вместо отрицания; мёртвые метафоры → конкретику; живой язык вместо канцелярита («использовать» вместо «осуществлять», «делать» вместо «производить»).`,
  },
  {
    name: "sentences",
    rules: `ПРЕДЛОЖЕНИЯ: деятель в подлежащем; активный залог; сказуемое ближе к началу (в предложениях длиннее 20 слов проверь); известное → начало, новое → конец; цепочка known-new между предложениями; единая тема в абзаце; безглагольные обрывки («Быстро, но хрупко») → подлежащее + сказуемое; одно предложение — одна мысль, разбей и склей если нужно.`,
  },
  {
    name: "paragraphs",
    rules: `АБЗАЦЫ: главное первым; один абзац — одна мысль; где есть заголовки — делай их конкретными (не «Введение»/«Заключение»), не добавляй заголовки в текст без них; объясняй предпосылки раньше того, что от них зависит; структурируй для сканирования (подзаголовки, списки, короткие абзацы).`,
  },
  {
    name: "ai",
    rules: `AI-ПАТТЕРНЫ: убирай маркеры («важно отметить», «в современном мире», «следует учитывать»); рекламные штампы → факты; раздувание значимости → конкретный факт; «является»/«представляет собой» → тире или прямой глагол; шаблонные конструкции («не просто X, а Y», тройка-перечисление) → скажи прямо; прорежай AI-лексику (подчёркивает, отражает, играет ключевую роль, ландшафт, палитра, многогранный); чередуй длину предложений; упрощай пунктуацию (больше трёх запятых — разбей на два).`,
  },
];

// combined ruleset for the judge's readability grade (all four passes joined)
const RUBRIC_EN = PASS_EN.map((p) => p.rules).join("\n");
const RUBRIC_RU = PASS_RU.map((p) => p.rules).join("\n");

type Block = { id: string; text: string };
type Grade = "load" | "borderline" | "surplus";

// ---- segmentation: fence-aware, split on blank lines; code fences stay whole ----
function segment(text: string): Block[] {
  const lines = text.split("\n");
  const out: string[][] = [];
  let cur: string[] = [];
  let inFence = false;
  const flush = () => {
    if (cur.length) {
      out.push(cur);
      cur = [];
    }
  };
  for (const line of lines) {
    const t = line.trimStart();
    if (t.startsWith("```") || t.startsWith("~~~")) {
      inFence = !inFence;
      cur.push(line);
      continue;
    }
    if (inFence) {
      cur.push(line);
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    cur.push(line);
  }
  flush();
  return out.map((ls, i) => ({ id: `B${i + 1}`, text: ls.join("\n") }));
}

function render(blocks: Block[]): string {
  return blocks.map((b) => `[${b.id}] ${b.text}`).join("\n\n");
}

function reconstruct(blocks: Block[]): string {
  return blocks.map((b) => b.text).join("\n\n");
}

function wordCount(s: string): number {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
}

// short human+parent-readable label for a block: first non-fence line, truncated
function label(text: string): string {
  const firstLine =
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("```")) ?? text.trim();
  return firstLine.length > 50 ? firstLine.slice(0, 47) + "…" : firstLine;
}

// a block carries a deliberate connection if it contains [[...]] — this also
// matches ![[...]] embeds, since the embed wraps a wikilink. Detection is
// deterministic so the protection (Edit 1/2 in the wikilink spec) cannot miss one.
const WIKILINK = /\[\[[^\]]+\]\]/;
const hasWikilink = (text: string): boolean => WIKILINK.test(text);

// Reference spans the revise passes must keep verbatim and that never need
// rewording: wikilinks, embeds (![[...]]), and inline code. They are masked to
// opaque ⟦N⟧ tokens for the duration of revise, then restored (see revise()).
const MASK_RE = /!?\[\[[^\]]+\]\]|`[^`\n]+`/g;

// Deterministic typographic normalization. The revise model substitutes typeset
// glyphs (curly quotes, an em dash, a non-breaking hyphen) regardless of prompt
// instruction; this maps the finite set back. It touches only substitutes — it
// leaves Cyrillic and source guillemets alone, so it is safe for the RU rubric.
function normalizeTypography(s: string): string {
  return s
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/\s*[—―]\s*/g, " - ") // em dash / bar (clause break): space the hyphen, collapse adjacent whitespace so the model's glued "word—word" does not become "word-word"
    .replace(/[‐‑‒–]/g, "-") // hyphen/nbhyphen/figure/en (ranges) → bare -
    .replace(/…/g, "...")
    .replace(/ /g, " "); // nbsp → space
}

// ---- frontmatter: YAML metadata block fenced by --- at the very start ----
// Split off leading frontmatter so it passes through verbatim — it is metadata,
// not prose, and must never be segmented, cut, graded, or reworded. Returns the
// frontmatter (fences included, trailing newline kept) and the remaining body.
// A leading --- with no closing fence is not frontmatter, so the whole text is body.
function splitFrontmatter(text: string): { front: string; body: string } {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return { front: "", body: text };
  const lines = text.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].replace(/\r$/, "");
    if (t === "---" || t === "...") {
      const front = lines.slice(0, i + 1).join("\n") + "\n";
      const body = lines
        .slice(i + 1)
        .join("\n")
        .replace(/^\n/, ""); // drop one separating blank line
      return { front, body };
    }
  }
  return { front: "", body: text };
}

function detectLang(text: string): "en" | "ru" {
  const letters = text.match(/[a-zA-Zа-яА-ЯёЁ]/g) ?? [];
  if (letters.length === 0) return "en";
  const cyr = letters.filter((c) => /[а-яА-ЯёЁ]/.test(c)).length;
  return cyr / letters.length > 0.3 ? "ru" : "en";
}

// ---- Fireworks call with retry ----
// Retry once, but only on transient failures: a network/timeout throw, or a
// 429/5xx status. A 401/400/content-policy error fails the same way on retry, so
// retrying it only burns a second TIMEOUT_MS before the outer failsafe fires —
// fail those fast with the status in the message instead.
async function fw(
  model: string,
  messages: { role: string; content: string }[],
  opts: { json?: boolean; maxTokens?: number; temp?: number } = {},
): Promise<string> {
  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: opts.maxTokens ?? 2048,
    temperature: opts.temp ?? 0,
  };
  if (opts.json) body.response_format = { type: "json_object" };
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetch(FW, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.FIREWORKS_API_KEY}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 2000));
        continue; // network error / timeout: transient
      }
      throw e;
    }
    const j = await res.json().catch(() => ({}) as Record<string, unknown>); // 5xx gateways return HTML
    if (!res.ok) {
      if ((res.status === 429 || res.status >= 500) && attempt === 0) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      throw new Error(`FW ${res.status}: ${JSON.stringify(j).slice(0, 300)}`);
    }
    const content = (j as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message
      ?.content;
    if (typeof content !== "string") {
      throw new Error(`FW empty choices: ${JSON.stringify(j).slice(0, 300)}`);
    }
    return content;
  }
  throw new Error("FW unreachable"); // loop always returns or throws
}

// Defensive layer over json_object mode: that mode is a strong hint, not a
// guarantee — a thinking model (the JUDGE) can still emit reasoning around the
// JSON. Pull the first balanced {...} object so such violations parse instead of
// dropping to the passthrough failsafe. Kept deliberately, not redundant.
function extractJson(s: string): string {
  const start = s.indexOf("{");
  if (start < 0) throw new Error(`no JSON in: ${s.slice(0, 200)}`);
  let depth = 0,
    inStr = false,
    esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced JSON: ${s.slice(0, 200)}`);
}

async function askJson<T>(model: string, prompt: string, maxTokens: number): Promise<T> {
  const raw = await fw(model, [{ role: "user", content: prompt }], { json: true, maxTokens });
  return JSON.parse(extractJson(raw)) as T;
}

// ---- prompts ----
function cutPrompt(blocks: Block[]): string {
  return `You are a ruthless editor. The text below is likely over-written with out-of-scope and unnecessary blocks. First state the text's main point in one sentence, then keep only the load-bearing blocks — those the reader needs to understand or act on the main point — and drop the rest. Err toward cutting: drop generic follow-ups (how to verify afterwards, cautions, alternatives, related context about other actions), because an independent judge will restore any load-bearing block you wrongly dropped and flag genuinely borderline ones for a parent to review. Keep survivors verbatim; drop whole blocks only. Return ONLY JSON {"mainPoint":"<one sentence>","drop":[block id strings]}.

TEXT (block IDs in [Bn] markers):
${render(blocks)}`;
}

function judgePrompt(
  mainPoint: string,
  dropped: Block[],
  survivors: Block[],
  rubric: string,
): string {
  // dropped blocks carrying a wikilink are marked [wikilink] so the judge can
  // apply the never-surplus rule below; the clamp in cutText is the guarantee.
  const renderDropped = dropped
    .map((b) => `[${b.id}]${hasWikilink(b.text) ? " [wikilink]" : ""} ${b.text}`)
    .join("\n\n");
  return `You are an independent judge grading an editor's cut. You see the text's main point, the blocks the editor DROPPED, and the blocks that SURVIVE. Grade three dimensions. Return ONLY JSON.

MAIN POINT: ${mainPoint}

DROPPED blocks:
${renderDropped}

SURVIVING blocks:
${render(survivors)}

Grade each:
1. "fluff": among the SURVIVING blocks, count those out-of-scope (irrelevant to the main point). {"count": int, "blocks": [ids]}
2. "readability": grade the surviving text against the clarity rules below. {"grade": "PASS"|"MARGINAL"|"FAIL", "violations": [short strings]}
3. "correctness" (answerability + graded): First, using ONLY the SURVIVING blocks, construct the most complete expression of the MAIN POINT you can, and note any part you cannot express or that a reader could not act on without more. Then grade EACH DROPPED block:
   - "load": its absence leaves a GAP — the reader cannot carry out the specific action the text recommends, or cannot judge whether that action applies to their situation.
   - "borderline": no gap that blocks the action, but the block bears on whether the advice fits the reader's case or on performing the action safely; a reviewing reader (or model with the source text) should judge whether to restore it. It differs from a generic follow-up.
   - "surplus": out of scope of the main point, OR a generic follow-up the text does not require the reader to take (how to verify the result afterwards, cautions, alternatives, or related context about other actions); nothing relevant is lost by dropping it.
   A block marked [wikilink] carries a deliberate connection: grade it "load" (inline in load-bearing prose) or "borderline" (e.g. a bare list of related links) — those are its only valid grades.
   correctness "verdict" is "FAIL" iff ANY dropped block is "load"; otherwise "PASS".
   {"verdict":"PASS"|"FAIL", "answer":"<your expression from survivors, or what is missing>", "blocks":[{"id":"Bn","grade":"load|borderline|surplus","reason":"..."}], "issue":"<if FAIL, the load block(s) + the gap; else empty>"}

${rubric}

Return ONLY: {"fluff":{"count":0,"blocks":[]},"readability":{"grade":"PASS","violations":[]},"correctness":{"verdict":"PASS","answer":"","blocks":[],"issue":""}}`;
}

function revisePrompt(blocks: Block[], pass: Pass): string {
  return `You are a copy editor. This is the ${pass.name.toUpperCase()} pass. Revise each block below applying only the rules below. Preserve its claims, keep all its content, and match the original's structure exactly (same headings, bullets, and formatting). Keep code blocks verbatim, and reproduce any ⟦N⟧ placeholder tokens unchanged. Preserve emphasis (**bold**, _italic_). Write straight quotes and plain hyphens. Return ONLY JSON {"blocks":[{"id":"B1","text":"revised text"}, ...]} — one entry per block, ids matching.

${pass.rules}

TEXT:
${render(blocks)}`;
}

// ---- pipeline ----
async function cutText(
  text: string,
  lang: "en" | "ru",
  noRevise: boolean,
): Promise<{ out: string; footer: string; flagged: string[] }> {
  const rubric = lang === "ru" ? RUBRIC_RU : RUBRIC_EN;
  const passes = lang === "ru" ? PASS_RU : PASS_EN;
  const blocks = segment(text);
  const beforeWords = wordCount(text);
  // no-cut tail: nothing was dropped (single block, or editor kept everything).
  // Optionally revise, then build the footer. Shared by both early exits below.
  const noCut = async (
    tag: string,
  ): Promise<{ out: string; footer: string; flagged: string[] }> => {
    if (noRevise) return { out: text, footer: `— ${tag} · ${beforeWords} words`, flagged: [] };
    const out = reconstruct(await revise(blocks, passes));
    return {
      out,
      footer: `— ${tag} · revised · ${beforeWords}→${wordCount(out)} words`,
      flagged: [],
    };
  };
  if (blocks.length <= 1) return noCut("no cut (single block)");

  // 1. editor cut
  const cut = await askJson<{ mainPoint: string; drop: string[] }>(EDITOR, cutPrompt(blocks), 1024);
  const mainPoint = cut.mainPoint ?? "";
  const dropSet = new Set((cut.drop ?? []).filter((id) => blocks.some((b) => b.id === id)));
  if (dropSet.size === 0) return noCut("no cut");

  const dropped = blocks.filter((b) => dropSet.has(b.id));
  const survivors = blocks.filter((b) => !dropSet.has(b.id));

  // 2. judge grade (the safety gate + flag source)
  const judged = await askJson<{
    correctness: { blocks: { id: string; grade: Grade; reason: string }[] };
  }>(JUDGE, judgePrompt(mainPoint, dropped, survivors, rubric), 8192);
  const gradeById = new Map<string, Grade>();
  for (const b of judged.correctness?.blocks ?? []) {
    if (b.id && b.grade) gradeById.set(b.id, b.grade);
  }
  // clamp: a dropped block carrying a wikilink can never be surplus or ungraded —
  // force at least borderline so a deliberate connection is flagged for restore,
  // never silently lost. A missing grade would otherwise fall through to a silent drop.
  for (const b of dropped) {
    if (hasWikilink(b.text) && gradeById.get(b.id) !== "load") {
      gradeById.set(b.id, "borderline");
    }
  }

  // 3. reconstruct: restore load, drop surplus, drop+flag borderline. Filtering over
  // `blocks` keeps original order; load-graded drops are restored, borderline flagged.
  const kept = blocks.filter((b) => !dropSet.has(b.id) || gradeById.get(b.id) === "load");
  const flagged = dropped.filter((b) => gradeById.get(b.id) === "borderline");

  // 4. revise survivors (word/sentence-level rubric)
  const finalBlocks = noRevise ? kept : await revise(kept, passes);
  const out = reconstruct(finalBlocks);
  const afterWords = wordCount(out);
  const nDropped = blocks.length - kept.length;

  // 5. footer (stderr): name the borderline cuts so the parent can restore them
  const labels = flagged.map((b) => `[${label(b.text)}]`).join(" ");
  const parts = [
    `— cut ${nDropped} block(s)`,
    `${beforeWords}→${afterWords} words`,
    `${flagged.length} questionable${labels ? `: ${labels}` : ""}`,
    "restore from source if needed",
  ];
  return { out, footer: parts.join(" · "), flagged: flagged.map((b) => b.text) };
}

async function revise(blocks: Block[], passes: Pass[]): Promise<Block[]> {
  // Mask reference spans ([[wikilinks]], ![[embeds]], inline code) to opaque ⟦N⟧
  // tokens before the passes so the rewriting model cannot reword or drop them;
  // restored verbatim at the end. Emphasis is left unmasked (it spans words that
  // legitimately get reworded) and relies on the prompt instruction instead.
  const masks = new Map<string, string>();
  let n = 0;
  const mask = (text: string): string =>
    text.replace(MASK_RE, (m) => {
      const key = `⟦${n++}⟧`;
      masks.set(key, m);
      return key;
    });
  const unmask = (text: string): string => {
    let out = text;
    for (const [key, orig] of masks) out = out.split(key).join(orig);
    return out;
  };

  // sequential passes: each refines the prior pass's output (words → sentences →
  // paragraphs → AI patterns). A failed pass (parse/network) keeps the current
  // blocks so prior improvements survive; the loop continues.
  let cur = blocks.map((b) => ({ id: b.id, text: mask(b.text) }));
  for (const pass of passes) {
    try {
      const { blocks: rev } = await askJson<{ blocks: { id: string; text: string }[] }>(
        EDITOR,
        revisePrompt(cur, pass),
        4096,
      );
      const byId = new Map(rev.map((r) => [r.id, r.text]));
      cur = cur.map((b) => ({ id: b.id, text: byId.get(b.id) ?? b.text }));
    } catch {
      // a failed pass keeps the current blocks (see above); continue
    }
  }
  // normalize typography on the model's prose, then restore masked spans verbatim
  // so injected originals are untouched by the normalize step.
  return cur.map((b) => ({ id: b.id, text: unmask(normalizeTypography(b.text)) }));
}

// ---- arg parsing + io ----
function parseArgs(argv: string[]): { lang: "en" | "ru" | "auto"; noRevise: boolean } {
  let lang: "en" | "ru" | "auto" = "auto";
  let noRevise = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--lang" && argv[i + 1]) lang = argv[i + 1] as "en" | "ru" | "auto";
    if (argv[i] === "--no-revise") noRevise = true;
  }
  return { lang, noRevise };
}

// Create an empty temp file with a .md extension and return its path. The cut
// result is written here instead of stdout so the caller gets a real .md artifact
// (openable, diffable) and stdout carries only the path + footer.
function tempMdPath(): string {
  return execFileSync("mktemp", ["--suffix=.md"], { encoding: "utf8" }).trim();
}

async function main() {
  if (!process.env.FIREWORKS_API_KEY) {
    console.error(
      "FIREWORKS_API_KEY not set (run under: doppler run --project claude-code --config std --)",
    );
    process.exit(1);
  }
  const { lang, noRevise } = parseArgs(process.argv.slice(2));
  const input = readFileSync(0, "utf8");
  if (!input.trim()) {
    process.exit(0);
  }
  // Strip leading frontmatter: it passes through verbatim and the pipeline (incl.
  // language detection) operates on the body only. Body-only input is unaffected.
  const { front, body } = splitFrontmatter(input);
  const path = tempMdPath();
  if (!body.trim()) {
    writeFileSync(path, input);
    process.stdout.write(`${path}\n— no body to cut\n`);
    process.exit(0);
  }
  const resolved = lang === "auto" ? detectLang(body) : lang;
  try {
    const { out, footer, flagged } = await cutText(body, resolved, noRevise);
    const final = front ? front + "\n" + out : out;
    // Append each footer-flagged (borderline) block verbatim below the cut text,
    // each behind a `---` separator, so the parent can splice it back in place.
    const fileBody = [final, ...flagged].join("\n\n---\n\n");
    writeFileSync(path, fileBody + (fileBody.endsWith("\n") ? "" : "\n"));
    process.stdout.write(`${path}\n${footer}\n`);
  } catch (e) {
    // failsafe: temp file holds the original (passthrough); path still printed
    writeFileSync(path, input);
    process.stdout.write(`${path}\n— cut skipped (error): ${String(e).slice(0, 160)}\n`);
    process.exit(0);
  }
}

main();
