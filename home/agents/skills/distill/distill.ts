#!/usr/bin/env bun
// distill — abstractive idea-compression: re-express a note as a dense Glossary.
//
// Not extractive (cut's verbatim-survivor trim, retired). distill rebuilds the
// note around a canonical form: a `## Glossary` table + a short prose tie-together,
// with only operational tokens (commands, paths, flags, code) kept verbatim.
// Restatement collapses structurally (N surface forms of one idea → one entry).
//
// Pipeline (5 stages): segment → (1) extract combo {description, thesis, glossary
// with relations + source pointers} (gpt-oss-120b) → (2) grade each block
// drop/distill/retain (gpt-oss-120b) → (3) synthesize glossary defs via the
// fidelity dial render|regenerate → (4) revise the distilled prose (4 writing
// passes) → (5) fidelity-grade output⟷raw-input by round-trip entailment with a
// DIFFERENT model (glm-5p2); residue is re-rendered from source, capped, then
// surfaced. Independence of writer (EXTRACT) and grader (FIDELITY) is the safety
// property — the verbatim certificate is gone, so the gate is equivalence.
//
// Output: written to a fresh temp .md file (mktemp), XML-wrapped. <result>…</result>
// holds exactly the text to write back to source (frontmatter verbatim + distilled
// body); <residue>…</residue> (omitted when empty) holds one <entry> per definition
// that failed the gate, with verbatim <source>, so a parent can re-read it. stdout
// is two lines — the file path, then a one-line summary footer. Failsafe: any error
// → the temp file holds the original text (passthrough), path still printed.
//
// Standalone headless CLI. Fireworks via FIREWORKS_API_KEY (e.g.
// `doppler run --project claude-code --config std --`).
//
// Usage:  distill-text input.md                      # read from file (auto-detect language)
//         distill-text < input.txt                   # read from stdin
//         distill-text --lang ru < input.txt         # force Russian rubric
//         distill-text --synth regenerate input.md   # denser dial (default: render)
//         distill-text --max-retries 1 input.md      # cap stage-5 recovery (default: 2)
//         distill-text --no-gate input.md            # skip stage-5 fidelity gate
//         distill-text --no-revise input.md          # skip stage-4 writing passes
//         distill-text render glossary.md            # separate, on-demand: prose note FROM a distilled glossary
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const FW = "https://api.fireworks.ai/inference/v1/chat/completions";
const EXTRACT = "accounts/fireworks/models/gpt-oss-120b"; // fast, obedient; ~3 s — stages 1-3 + revise
const FIDELITY = "accounts/fireworks/models/glm-5p2"; // thinking; ~15-20 s — stage 5 only (the different model)
const TIMEOUT_MS = 180_000;

// ---- writing passes (the revise-stage rubric — inline single source) ----
// Four focused rule sets applied in sequence (words → sentences → paragraphs →
// AI patterns); each call refines the prior pass's output. These condensed rules
// are the whole rubric; there is no separate reference file to keep in sync.
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

type Block = { id: string; text: string };
type Grade = "drop" | "distill" | "retain";
type GlossEntry = { term: string; def: string; relations: string[]; source: string[] };
type IR = { description: string; thesis: string; glossary: GlossEntry[] };

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

function wordCount(s: string): number {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
}

// a block carries a deliberate connection if it contains [[...]] — this also
// matches ![[...]] embeds, since the embed wraps a wikilink. Detection is
// deterministic so the protection cannot miss one.
const WIKILINK = /\[\[[^\]]+\]\]/;
const hasWikilink = (text: string): boolean => WIKILINK.test(text);

// a block carries operational tokens that must survive verbatim — code, CLI
// flags, file paths. Used by the wikilink clamp to choose retain over distill.
const hasOperational = (text: string): boolean =>
  /```|`[^`\n]+`|\s--?[a-z]/i.test(text) || /(^|\s)(\/|~\/|\.\/)\S+/.test(text);

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
    .replace(/\s*[—―]\s*/g, " - ") // em dash / bar (clause break): space the hyphen, collapse adjacent whitespace
    .replace(/[‐‑‒–]/g, "-") // hyphen/nbhyphen/figure/en (ranges) → bare -
    .replace(/…/g, "...")
    .replace(/ /g, " "); // nbsp → space
}

// ---- frontmatter: YAML metadata block fenced by --- at the very start ----
// Split off leading frontmatter so it passes through verbatim — it is metadata,
// not prose, and must never be segmented, graded, or reworded. Returns the
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

// Pull an authored single-line `description:` value out of frontmatter. This is
// the one independent ground-truth anchor — when present it overrides the
// model's extracted description so the anchor is never paraphrased. A blank or
// block-scalar (|/>) description is treated as absent (nothing authored to pin).
function parseDescription(front: string): string {
  const m = front.match(/^description:[ \t]*(.+)$/m);
  if (!m) return "";
  const v = m[1].trim().replace(/^["']|["']$/g, "");
  if (!v || v === "|" || v === ">") return "";
  return v;
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
// guarantee — a thinking model (the FIDELITY judge) can still emit reasoning
// around the JSON. Pull the first balanced {...} object so such violations parse
// instead of dropping to the passthrough failsafe. Kept deliberately.
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

// distill generates new natural-language text (abstractive), so every prompt must
// pin the output language to the note's own — else a Russian note distills to English.
const langName = (lang: "en" | "ru"): string => (lang === "ru" ? "Russian" : "English");
const langRule = (lang: "en" | "ru"): string =>
  `Write every natural-language value (description, thesis, term, def, relations, prose) in ${langName(lang)} — match the note's own language. Keep code, paths, identifiers, and [[wikilink]] targets verbatim.`;

// ---- stage 1: extract the combo (description, thesis, glossary) ----
function extractComboPrompt(blocks: Block[], frontDescription: string, lang: "en" | "ru"): string {
  const descRule = frontDescription
    ? `Use this authored description VERBATIM: "${frontDescription}"`
    : `Write ONE sentence naming what the note is about.`;
  return `You are a concept cartographer. Read the note below (block IDs in [Bn] markers) and produce its compressed idea-graph as JSON. ${langRule(lang)}
- "description": ${descRule}
- "thesis": the single spine claim the whole note argues, one sentence.
- "glossary": the note's LOAD-BEARING concepts — the named ideas a reader must hold to follow the thesis. Typically 4-10, NOT every noun phrase. A concept earns an entry only if the note both NAMES and DEFINES it; leave passing sentences, one-off examples, and restating clauses out of the glossary. For each: "term" (the concept's name), "def" (dense, in YOUR OWN words, <=20 words), "relations" (array of strings: how it ties to OTHER terms — "subsumes X", "precondition for Y", "contrast to Z"; NOT a bare restatement of def), "source" (array of [Bn] id strings where it is defined or used, at least one).
Collapse restatements of the SAME concept into ONE entry whose "source" lists all the blocks that state it — do not emit a separate entry per surface form.
Return ONLY JSON {"description":"...","thesis":"...","glossary":[{"term":"...","def":"...","relations":["..."],"source":["Bn"]}]}.

TEXT (block IDs in [Bn] markers):
${render(blocks)}`;
}

async function extractCombo(
  blocks: Block[],
  frontDescription: string,
  lang: "en" | "ru",
): Promise<IR> {
  const ir = await askJson<IR>(EXTRACT, extractComboPrompt(blocks, frontDescription, lang), 4096);
  const ids = new Set(blocks.map((b) => b.id));
  const glossary = (ir.glossary ?? [])
    .map((e) => ({
      term: (e.term ?? "").trim(),
      def: (e.def ?? "").trim(),
      relations: Array.isArray(e.relations) ? e.relations : [],
      source: (e.source ?? []).filter((id) => ids.has(id)),
    }))
    // an entry with no valid source block cannot be rendered grounded or graded — drop it
    .filter((e) => e.term && e.source.length > 0);
  // the authored frontmatter description overrides the model's: the one anchor never paraphrased
  const description = frontDescription || (ir.description ?? "").trim();
  return { description, thesis: (ir.thesis ?? "").trim(), glossary };
}

// ---- stage 2: grade each block drop / distill / retain ----
function gradeBlocksPrompt(ir: IR, blocks: Block[]): string {
  const gloss = ir.glossary.map((e) => `- ${e.term}: ${e.def}`).join("\n");
  return `You are grading each block of a note for an abstractive compression. You have the note's thesis and its glossary of concepts. Grade EVERY block:
- "drop": off-thesis, OR its content is already captured by a glossary entry (a restatement).
- "distill": on-thesis prose whose ideas should be re-expressed densely — it folds into the glossary and a short prose tie-together. This is the DEFAULT for explanatory text.
- "retain": ONLY content that is already compact and would be destroyed by rewording — a fenced code block, a command line, a file path, a flag, literal output, or a list made mostly of [[wikilink]] references (a "related"/"see also" list). Narrative or explanatory PROSE is NEVER "retain", even when it is important, names an example, or contains a [[wikilink]] — that prose is "distill". When unsure between distill and retain, choose distill.
Return ONLY JSON {"grades":[{"id":"Bn","grade":"drop|distill|retain"}]} — one entry per block, ids matching.

THESIS: ${ir.thesis}

GLOSSARY:
${gloss}

BLOCKS (ids in [Bn] markers):
${render(blocks)}`;
}

async function gradeBlocks(ir: IR, blocks: Block[]): Promise<Map<string, Grade>> {
  const judged = await askJson<{ grades: { id: string; grade: Grade }[] }>(
    EXTRACT,
    gradeBlocksPrompt(ir, blocks),
    2048,
  );
  const byId = new Map<string, Grade>();
  for (const g of judged.grades ?? []) {
    if (g.id && (g.grade === "drop" || g.grade === "distill" || g.grade === "retain")) {
      byId.set(g.id, g.grade);
    }
  }
  // default any ungraded block to distill (folds into the glossary; never silent-dropped)
  for (const b of blocks) if (!byId.has(b.id)) byId.set(b.id, "distill");
  // wikilink clamp: a block carrying a deliberate connection can never be dropped —
  // force retain if operational, else distill, so the connection survives in output.
  for (const b of blocks) {
    if (hasWikilink(b.text) && byId.get(b.id) === "drop") {
      byId.set(b.id, hasOperational(b.text) ? "retain" : "distill");
    }
  }
  return byId;
}

// ---- stage 3: synthesize glossary definitions (the fidelity dial) ----
type Synth = "render" | "regenerate";

function sourceTextFor(entry: GlossEntry, blockById: Map<string, Block>): string {
  return entry.source
    .map((id) => blockById.get(id)?.text ?? "")
    .filter(Boolean)
    .join("\n---\n");
}

function synthEntriesPrompt(
  ir: IR,
  entries: GlossEntry[],
  mode: Synth,
  blockById: Map<string, Block>,
  lang: "en" | "ru",
): string {
  if (mode === "render") {
    const concepts = entries
      .map(
        (e) =>
          `### ${e.term}\nrelations: ${e.relations.join("; ")}\nSOURCE:\n${sourceTextFor(e, blockById)}`,
      )
      .join("\n\n");
    return `You are writing glossary definitions for a compressed note. For each concept, write its "def" grounded in the SOURCE text provided for it — but RE-EXPRESS it densely in your own words (<=20 words, one clause). Do NOT copy a source sentence verbatim; compress it. Keep every named relation; introduce NO claim absent from the source. Keep \`inline code\`, file paths, and ⟦N⟧ tokens verbatim. ${langRule(lang)} Return ONLY JSON {"entries":[{"term":"...","def":"..."}]} — one per concept, terms matching.

CONCEPTS:
${concepts}`;
  }
  const concepts = entries
    .map((e) => `### ${e.term}\ndef(draft): ${e.def}\nrelations: ${e.relations.join("; ")}`)
    .join("\n\n");
  return `You are writing glossary definitions for a compressed note from its extracted idea-graph alone. For each concept, write a maximally dense "def" that preserves its relations. Stay on the thesis; introduce NO new concept. ${langRule(lang)} Return ONLY JSON {"entries":[{"term":"...","def":"..."}]} — one per concept, terms matching.

THESIS: ${ir.thesis}

CONCEPTS:
${concepts}`;
}

async function synthEntries(
  ir: IR,
  entries: GlossEntry[],
  mode: Synth,
  blockById: Map<string, Block>,
  lang: "en" | "ru",
): Promise<Map<string, string>> {
  const out = new Map<string, string>(entries.map((e) => [e.term, e.def])); // fall back to IR def
  if (entries.length === 0) return out;
  const res = await askJson<{ entries: { term: string; def: string }[] }>(
    EXTRACT,
    synthEntriesPrompt(ir, entries, mode, blockById, lang),
    4096,
  );
  for (const e of res.entries ?? []) if (e.term && e.def) out.set(e.term.trim(), e.def.trim());
  return out;
}

// single-entry render from source — used by stage-5 recovery to re-ground a residue def
function renderEntryPrompt(entry: GlossEntry, sourceText: string, lang: "en" | "ru"): string {
  return `Write the glossary definition for "${entry.term}" using ONLY the source text below. One dense sentence; keep every relation (${entry.relations.join("; ")}); introduce NO claim absent from the source. ${langRule(lang)} Return ONLY JSON {"def":"..."}.

SOURCE:
${sourceText}`;
}

function tieTogetherPrompt(ir: IR, lang: "en" | "ru"): string {
  const gloss = ir.glossary.map((e) => `- ${e.term}: ${e.def}`).join("\n");
  return `In 2-4 sentences, state the note's thesis and how its main glossary terms connect. Use only concepts already in the glossary. Plain declarative prose — no heading, no list. ${langRule(lang)} Return ONLY JSON {"prose":"..."}.

THESIS: ${ir.thesis}

GLOSSARY:
${gloss}`;
}

async function tieTogether(ir: IR, lang: "en" | "ru"): Promise<string> {
  if (ir.glossary.length === 0) return "";
  try {
    const res = await askJson<{ prose: string }>(EXTRACT, tieTogetherPrompt(ir, lang), 1024);
    return (res.prose ?? "").trim();
  } catch {
    return ir.thesis; // a failed tie-together degrades to the bare thesis sentence
  }
}

// ---- writing passes (stage 4): reuse cut's four sequential rewrites ----
function revisePrompt(blocks: Block[], pass: Pass): string {
  return `You are a copy editor. This is the ${pass.name.toUpperCase()} pass. Revise each block below applying only the rules below. Preserve its claims, keep all its content, and match the original's structure exactly (same headings, bullets, and formatting). Keep code blocks verbatim, and reproduce any ⟦N⟧ placeholder tokens unchanged. Preserve emphasis (**bold**, _italic_). Write straight quotes and plain hyphens. Return ONLY JSON {"blocks":[{"id":"B1","text":"revised text"}, ...]} — one entry per block, ids matching.

${pass.rules}

TEXT:
${render(blocks)}`;
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
  const unmask = (text: string): string =>
    masks.size === 0 ? text : text.replace(/⟦\d+⟧/g, (m) => masks.get(m) ?? m);

  // sequential passes: each refines the prior pass's output (words → sentences →
  // paragraphs → AI patterns). A failed pass (parse/network) keeps the current
  // blocks so prior improvements survive; the loop continues.
  let cur = blocks.map((b) => ({ id: b.id, text: mask(b.text) }));
  for (const pass of passes) {
    try {
      const { blocks: rev } = await askJson<{ blocks: { id: string; text: string }[] }>(
        EXTRACT,
        revisePrompt(cur, pass),
        4096,
      );
      const byId = new Map(rev.map((r) => [r.id, r.text]));
      cur = cur.map((b) => ({ id: b.id, text: byId.get(b.id) ?? b.text }));
    } catch {
      // a failed pass keeps the current blocks (see above); continue
    }
  }
  return cur.map((b) => ({ id: b.id, text: unmask(normalizeTypography(b.text)) }));
}

// ---- stage 5: fidelity gate (round-trip entailment, different model) ----
type Concept = {
  term: string;
  grade: "translated" | "residue";
  direction: string;
  missing: string;
};

function fidelityPrompt(
  thesis: string,
  outputBody: string,
  rendered: { term: string; def: string; sourceText: string }[],
): string {
  const concepts = rendered
    .map((r) => `### ${r.term}\nSOURCE:\n${r.sourceText}\nOUTPUT: ${r.def}`)
    .join("\n\n");
  return `You are an independent fidelity judge. You did NOT write this compression. For EACH concept you see its SOURCE (verbatim from the original note) and its OUTPUT (the compressed definition). Decide round-trip entailment in BOTH directions:
- does OUTPUT entail SOURCE (nothing load-bearing dropped)?
- does SOURCE entail OUTPUT (nothing invented)?
Grade "translated" if both hold; "residue" if either fails — name the direction ("output-misses-source" or "output-invents") and what is missing or invented.
Also judge whether the THESIS is still recoverable from the OUTPUT alone.
Return ONLY JSON {"thesisRecoverable":true|false,"concepts":[{"term":"...","grade":"translated|residue","direction":"both|output-misses-source|output-invents","missing":"..."}]}.

THESIS: ${thesis}

OUTPUT (the compressed note):
${outputBody}

CONCEPTS:
${concepts}`;
}

async function fidelityGate(
  thesis: string,
  outputBody: string,
  rendered: { term: string; def: string; sourceText: string }[],
): Promise<{ thesisRecoverable: boolean; concepts: Concept[] }> {
  const res = await askJson<{ thesisRecoverable?: boolean; concepts?: Concept[] }>(
    FIDELITY,
    fidelityPrompt(thesis, outputBody, rendered),
    8192,
  );
  return {
    thesisRecoverable: res.thesisRecoverable !== false,
    concepts: (res.concepts ?? []).filter((c) => c.term),
  };
}

// ---- assembly: glossary table + prose tie-together + retained-verbatim blocks ----
function escCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}

const escAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

function assembleBody(
  h1: string,
  tie: string,
  orderedEntries: GlossEntry[],
  defByTerm: Map<string, string>,
  retained: Block[],
): string {
  const parts: string[] = [];
  if (h1) parts.push(h1);
  if (tie) parts.push(tie);
  if (orderedEntries.length) {
    const rows = orderedEntries
      .map((e) => `| ${escCell(e.term)} | ${escCell(defByTerm.get(e.term) ?? e.def)} |`)
      .join("\n");
    parts.push(`## Glossary\n\n| Term | Definition |\n| ---- | ---------- |\n${rows}`);
  }
  if (retained.length) parts.push(retained.map((b) => b.text).join("\n\n"));
  return parts.join("\n\n");
}

// ---- render mode: reconstruct a prose note from a distilled glossary ----
// The inverse of the compress pipeline. Input is a distilled file (this tool's
// own output, or a saved glossary note): frontmatter + a tie-together line + a
// `## Glossary` table + optional retained blocks. Output is a flowing prose note
// grounded ONLY in that glossary — the certified reference. No fidelity gate: the
// glossary is the certified artifact, the prose its readable derivative (always
// regenerable and checkable against it). The glossary table is dropped from output.

// If the input is wrapped in <result>…</result> (the raw temp file this tool
// emits), use the inner content and ignore any <residue>; otherwise use as-is.
function unwrapResult(text: string): string {
  const m = text.match(/<result>\r?\n?([\s\S]*?)\r?\n?<\/result>/);
  return m ? m[1] : text;
}

const stripH1 = (s: string): string => s.replace(/^#\s+[^\n]*\r?\n?/, "");

// Parse a distilled body into its parts: the tie-together prose (head, minus any
// H1), the glossary entries (the `## Glossary` table — header/separator rows
// skipped, `\|` unescaped, the inverse of escCell + assembleBody), and any
// retained blocks after the table (e.g. a wikilink reference list).
function parseDistilled(body: string): {
  tie: string;
  entries: { term: string; def: string }[];
  retained: string;
} {
  const gi = body.match(/^##\s+Glossary\b.*$/im);
  if (!gi || gi.index === undefined) {
    return { tie: stripH1(body).trim(), entries: [], retained: "" };
  }
  const head = body.slice(0, gi.index);
  const after = body.slice(gi.index + gi[0].length).split("\n");
  const rows: string[] = [];
  let j = 0;
  for (; j < after.length; j++) {
    const t = after[j].trim();
    if (t === "") {
      if (rows.length) break; // a blank after the rows ends the table
      continue; // blank between heading and table
    }
    if (t.startsWith("|")) {
      rows.push(t);
      continue;
    }
    break; // first non-blank non-row line ends the table
  }
  const retained = after.slice(j).join("\n").trim();
  const entries: { term: string; def: string }[] = [];
  for (const row of rows) {
    const cells = row
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split(/(?<!\\)\|/)
      .map((c) => c.replace(/\\\|/g, "|").trim());
    if (cells.length < 2) continue;
    const [term, def] = cells;
    if (!term || term.toLowerCase() === "term") continue; // header row
    if (/^:?-{3,}:?$/.test(term.replace(/\s/g, ""))) continue; // separator row
    entries.push({ term, def });
  }
  return { tie: stripH1(head).trim(), entries, retained };
}

function renderPrompt(
  description: string,
  tie: string,
  entries: { term: string; def: string }[],
  lang: "en" | "ru",
): string {
  const gloss = entries.map((e) => `- ${e.term}: ${e.def}`).join("\n");
  return `You are reconstructing a readable prose note from its distilled glossary. Write flowing prose (connected markdown paragraphs) using ONLY the description, thesis, and glossary definitions below — introduce NO claim, term, or example absent from them. Do NOT emit a glossary, a table, a bullet list of the terms, or section headings; write paragraphs a reader follows start to finish. Lead with the thesis, then develop each concept and how it relates to the others. ${langRule(lang)} Return ONLY JSON {"prose":"..."}.

DESCRIPTION: ${description || "(none)"}

THESIS / TIE:
${tie || "(none)"}

GLOSSARY:
${gloss}`;
}

async function renderProse(
  description: string,
  tie: string,
  entries: { term: string; def: string }[],
  lang: "en" | "ru",
): Promise<string> {
  const res = await askJson<{ prose: string }>(
    EXTRACT,
    renderPrompt(description, tie, entries, lang),
    4096,
  );
  return (res.prose ?? "").trim();
}

// Drive render mode: parse → synthesize prose → revise (no gate) → assemble.
// Failsafe mirrors the compress path: any error → the original is passed through.
async function runRender(
  input: string,
  opts: { lang: "en" | "ru" | "auto"; noRevise: boolean },
  emit: (body: string, footer: string) => void,
): Promise<void> {
  try {
    const { front, body } = splitFrontmatter(unwrapResult(input));
    const { tie, entries, retained } = parseDistilled(body);
    if (entries.length === 0) {
      emit(input, "— render skipped: no ## Glossary table found");
      return;
    }
    const lang = opts.lang === "auto" ? detectLang(body) : opts.lang;
    let prose = await renderProse(parseDescription(front), tie, entries, lang);
    if (!prose) {
      emit(input, "— render skipped: empty prose");
      return;
    }
    if (!opts.noRevise) {
      const revised = await revise(segment(prose), lang === "ru" ? PASS_RU : PASS_EN);
      prose = revised.map((b) => b.text).join("\n\n");
    }
    const outBody = retained ? `${prose}\n\n${retained}` : prose;
    const result = front ? front + "\n" + outBody : outBody;
    emit(
      `<result>\n${result}\n</result>\n`,
      `— rendered prose · ${wordCount(body)}→${wordCount(outBody)} words · ${entries.length} entries`,
    );
  } catch (e) {
    emit(input, `— render skipped (error): ${String(e).slice(0, 160)}`);
  }
}

// ---- pipeline ----
type Residue = { term: string; reason: string; source: string };
async function distill(
  text: string,
  lang: "en" | "ru",
  frontDescription: string,
  opts: { synth: Synth; maxRetries: number; noRevise: boolean; noGate: boolean },
): Promise<{ out: string; footer: string; residue: Residue[] }> {
  const passes = lang === "ru" ? PASS_RU : PASS_EN;
  const blocks = segment(text);
  const blockById = new Map(blocks.map((b) => [b.id, b]));
  const blockIndex = new Map(blocks.map((b, i) => [b.id, i]));
  const beforeWords = wordCount(text);

  // 1. extract combo
  const ir = await extractCombo(blocks, frontDescription, lang);
  if (ir.glossary.length === 0) {
    // nothing to distill: no concepts extracted. Passthrough, footer notes it.
    return { out: text, footer: `— no concepts extracted · ${beforeWords} words`, residue: [] };
  }

  // 2. grade blocks
  const grades = await gradeBlocks(ir, blocks);
  const retained = blocks.filter((b) => grades.get(b.id) === "retain");

  // order entries by first appearance of their lowest source block (note's own order)
  const orderKey = (e: GlossEntry) => Math.min(...e.source.map((id) => blockIndex.get(id) ?? 1e9));
  const orderedEntries = [...ir.glossary].sort((a, b) => orderKey(a) - orderKey(b));

  // 3. synthesize definitions via the dial + the prose tie-together
  const [defByTerm, tie0] = await Promise.all([
    synthEntries(ir, orderedEntries, opts.synth, blockById, lang),
    tieTogether(ir, lang),
  ]);
  let tie = tie0;

  // 4. revise the distilled prose (tie-together + each def), structure untouched
  if (!opts.noRevise) {
    const dblocks: Block[] = [
      { id: "__TIE__", text: tie },
      ...orderedEntries.map((e, i) => ({
        id: `__G${i}__`,
        text: defByTerm.get(e.term) ?? e.def,
      })),
    ];
    const rev = await revise(dblocks, passes);
    const byId = new Map(rev.map((b) => [b.id, b.text]));
    tie = byId.get("__TIE__") ?? tie;
    orderedEntries.forEach((e, i) => {
      const t = byId.get(`__G${i}__`);
      if (t) defByTerm.set(e.term, t);
    });
  }

  const h1 = blocks.find((b) => /^#\s/.test(b.text))?.text.split("\n")[0] ?? "";
  let out = assembleBody(h1, tie, orderedEntries, defByTerm, retained);

  // 5. fidelity gate + recovery (round-trip entailment, capped re-render from source)
  const residue: Residue[] = [];
  let retries = 0;
  if (!opts.noGate) {
    const rendered = () =>
      orderedEntries.map((e) => ({
        term: e.term,
        def: defByTerm.get(e.term) ?? e.def,
        sourceText: sourceTextFor(e, blockById),
      }));
    let graded = await fidelityGate(ir.thesis, out, rendered());
    let failing = graded.concepts.filter((c) => c.grade === "residue");
    while (failing.length > 0 && retries < opts.maxRetries) {
      retries++;
      // re-render each residue entry from source (render mode) regardless of dial
      for (const c of failing) {
        const entry = orderedEntries.find((e) => e.term === c.term);
        if (!entry) continue;
        try {
          const r = await askJson<{ def: string }>(
            EXTRACT,
            renderEntryPrompt(entry, sourceTextFor(entry, blockById), lang),
            1024,
          );
          // recovery bypasses revise(), so normalize typography here too
          if (r.def) defByTerm.set(entry.term, normalizeTypography(r.def.trim()));
        } catch {
          // a failed re-render keeps the prior def; the gate re-grades it next
        }
      }
      out = assembleBody(h1, tie, orderedEntries, defByTerm, retained);
      // re-grade only the patched entries, not the full glossary (budget)
      const patchTerms = new Set(failing.map((c) => c.term));
      const reg = await fidelityGate(
        ir.thesis,
        out,
        rendered().filter((r) => patchTerms.has(r.term)),
      );
      failing = reg.concepts.filter((c) => c.grade === "residue");
    }
    // surviving residue (incl. an unrecoverable thesis) is surfaced, never silent
    for (const c of failing) {
      const entry = orderedEntries.find((e) => e.term === c.term);
      residue.push({
        term: c.term,
        reason: `${c.direction || "residue"}: ${c.missing || "failed round-trip entailment"}`,
        source: entry ? sourceTextFor(entry, blockById) : "",
      });
    }
    if (!graded.thesisRecoverable) {
      residue.unshift({
        term: "(thesis)",
        reason: "thesis not recoverable from output",
        source: ir.thesis,
      });
    }
  }

  const afterWords = wordCount(out);
  // passthrough guard: a distillation that expands the note has failed its one job.
  // Ship the original body rather than the larger output. (the footer's +N% only
  // flagged this after the fact; this prevents it.)
  if (afterWords > beforeWords) {
    return {
      out: text,
      footer: `— distillation expanded ${beforeWords}→${afterWords} words; kept original`,
      residue: [],
    };
  }
  const pct = beforeWords ? Math.round((100 * (beforeWords - afterWords)) / beforeWords) : 0;
  const sizeTag = `${pct > 0 ? "-" : pct < 0 ? "+" : "±"}${Math.abs(pct)}%`; // expansion is guarded above, so this is -N% or ±0%
  const retriesTag = retries ? ` · ${retries} retries` : "";
  const footer = `— distilled ${opts.synth} · ${beforeWords}→${afterWords} words (${sizeTag}) · ${orderedEntries.length} entries · ${retained.length} verbatim · ${residue.length} residue${retriesTag}`;
  return { out, footer, residue };
}

// ---- arg parsing + io ----
// Flags may appear in any position. Value-flags (--lang/--synth/--max-retries)
// consume the following token as their value, so that token is never mistaken for
// the positional path. The first token that is neither a flag nor a flag's
// consumed value is the input file path.
function parseArgs(argv: string[]): {
  lang: "en" | "ru" | "auto";
  synth: Synth;
  maxRetries: number;
  noRevise: boolean;
  noGate: boolean;
  path?: string;
} {
  let lang: "en" | "ru" | "auto" = "auto";
  let synth: Synth = "render";
  let maxRetries = 2;
  let path: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--lang" && argv[i + 1]) {
      lang = argv[++i] as "en" | "ru" | "auto";
      continue;
    }
    if (a === "--synth" && argv[i + 1]) {
      synth = argv[++i] === "regenerate" ? "regenerate" : "render";
      continue;
    }
    if (a === "--max-retries" && argv[i + 1]) {
      const n = parseInt(argv[++i], 10);
      if (Number.isFinite(n) && n >= 0) maxRetries = n;
      continue;
    }
    if (path === undefined && !a.startsWith("--")) path = a;
  }
  return {
    lang,
    synth,
    maxRetries,
    noRevise: argv.includes("--no-revise"),
    noGate: argv.includes("--no-gate"),
    path,
  };
}

// Create an empty temp file with a .md extension and return its path. The result
// is written here instead of stdout so the caller gets a real .md artifact
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
  // The first positional `render` selects prose-render mode (the inverse flow);
  // it is sliced off before flag parsing so the next token is the input path.
  const rawArgv = process.argv.slice(2);
  const mode: "compress" | "render" = rawArgv[0] === "render" ? "render" : "compress";
  const {
    lang,
    synth,
    maxRetries,
    noRevise,
    noGate,
    path: inputPath,
  } = parseArgs(mode === "render" ? rawArgv.slice(1) : rawArgv);
  const input = readFileSync(inputPath ?? 0, "utf8");
  if (!input.trim()) process.exit(0);
  const path = tempMdPath();
  const emit = (body: string, footer: string): void => {
    writeFileSync(path, body);
    process.stdout.write(`${path}\n${footer}\n`);
  };
  if (mode === "render") {
    await runRender(input, { lang, noRevise }, emit);
    return;
  }
  // compress mode: strip leading frontmatter (it passes through verbatim; the
  // pipeline + language detection operate on the body only).
  const { front, body } = splitFrontmatter(input);
  if (!body.trim()) {
    emit(input, "— no body to distill");
    process.exit(0);
  }
  const resolved = lang === "auto" ? detectLang(body) : lang;
  const frontDescription = parseDescription(front);
  try {
    const { out, footer, residue } = await distill(body, resolved, frontDescription, {
      synth,
      maxRetries,
      noRevise,
      noGate,
    });
    // <result> wraps exactly the text to write back to source: frontmatter
    // (verbatim, if any) + distilled body. <residue> carries one <entry> per
    // definition that failed the gate, with verbatim <source>; omitted when empty.
    const result = front ? front + "\n" + out : out;
    let fileBody = `<result>\n${result}\n</result>\n`;
    if (residue.length) {
      const entries = residue
        .map(
          (r) =>
            `<entry term="${escAttr(r.term)}" reason="${escAttr(r.reason)}">\n<source>\n${r.source}\n</source>\n</entry>`,
        )
        .join("\n");
      fileBody += `\n<residue>\n${entries}\n</residue>\n`;
    }
    emit(fileBody, footer);
  } catch (e) {
    // failsafe: temp file holds the original (passthrough); path still printed
    emit(input, `— distill skipped (error): ${String(e).slice(0, 160)}`);
    process.exit(0);
  }
}

main();
