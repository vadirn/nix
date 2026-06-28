#!/usr/bin/env bun
// distill — abstractive idea-compression: re-express a note as readable prose
// backed by a certified glossary.
//
// Not extractive (cut's verbatim-survivor trim, retired). distill rebuilds the
// note around a canonical form. By default the output is a readable note: flowing
// connective prose (which carries the THESIS and the RELATIONS among terms) above
// a `## Glossary` table of DEFINITIONS ONLY — division of labor, no duplication.
// Only operational tokens (commands, paths, flags, code) are kept verbatim.
// Restatement collapses structurally (N surface forms of one idea → one entry).
// `--core-only` drops the prose and emits just the glossary (tie + definitions).
//
// Two certified channels share the pipeline: the GLOSSARY (declarative — concepts
// to know) and the WORKFLOW (procedural — directives to do). The glossary cannot
// hold a practice or a procedure step, so a note's actionable payload used to
// dissolve; the workflow channel is its sink. It is optional — empty when the note
// prescribes nothing, in which case no `## Workflow` section is emitted.
//
// Pipeline (5 stages): segment → (1) extract combo {description, thesis, glossary
// with relations + source pointers, workflow steps + source pointers} (gpt-oss-120b)
// → (2) grade each block drop/distill/retain (gpt-oss-120b) → (3) synthesize
// glossary defs AND tighten workflow steps via the fidelity dial render|regenerate,
// then write the connective prose head from the defs+relations → (4) revise the
// distilled prose + steps (4 writing passes) → (5) fidelity-grade the glossary defs
// AND the workflow steps ⟷ raw-input by round-trip entailment with a DIFFERENT model
// (glm-5p2); residue is re-rendered from source, capped, then surfaced. Independence
// of writer (EXTRACT) and grader (FIDELITY) is the safety property — the verbatim
// certificate is gone, so the gate is equivalence. The gate certifies the glossary
// definitions and the workflow steps; the prose, which restates none of them, rides
// on those certified items and is not separately gated. Output order is prose →
// `## Workflow` → `## Glossary` → retained-verbatim.
//
// Output: written to a fresh temp .md file (mktemp), XML-wrapped. <result>…</result>
// holds exactly the text to write back to source (frontmatter verbatim + distilled
// body); <residue>…</residue> (omitted when empty) holds one <entry> per definition
// or step-group that failed the gate, with verbatim <source>, so a parent can re-read
// it. A `gate-inconclusive:` reason marks an item the judge could not grade (it
// returned no parseable verdict): the distillation still ships, that item just rides
// surfaced-but-unverified — a judge flake never discards the whole run. stdout is two
// lines — the file path, then a one-line summary footer. Failsafe: any error before
// the gate → the temp file holds the original text (passthrough), path still printed.
//
// Standalone headless CLI. Fireworks via FIREWORKS_API_KEY (e.g.
// `doppler run --project claude-code --config std --`).
//
// Usage:  distill-text input.md                      # prose + ## Glossary (auto-detect language)
//         distill-text < input.txt                   # read from stdin
//         distill-text --core-only input.md          # glossary only (tie + definitions), no prose
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
// Token budget for the FIDELITY thinking model. Its reasoning is inlined in the
// content, so the cap must cover BOTH the thinking and the trailing JSON — too low
// and the model exhausts it mid-thought, returning prose with no `{`, which fails
// extractJson and drops the whole run to the passthrough failsafe. Sized with
// headroom for the longest gate input (rationale-carrying workflow steps).
const FIDELITY_TOKENS = 16_384;

// Relations registry — TS-native copy of the open relation vocabulary (structural
// channel only, D32). Mirror of vault-query/src/commands/lint/rel-registry.json, the
// test-only canonical ground truth; parity is pinned by distill.test.ts (which reads
// that JSON and asserts equality with this const). Read at runtime from here, never
// from the JSON, so emit stays file-I/O-free. Three tokens the extractor already emits
// (subsumes / precondition-for / contrast-to) plus four it is starting to emit
// (depends-on / part-of / instance-of / refines). supersedes and contradicts are
// excluded by channel (frontmatter- and merge-gated respectively).
export const REL_REGISTRY: readonly string[] = [
  "subsumes",
  "precondition-for",
  "contrast-to",
  "depends-on",
  "part-of",
  "instance-of",
  "refines",
];

// Workflow-gate recovery ladder (stage-5 loop). A flagged step is repaired from
// the gate's own finding (judge-guided), then — if the repair still fails the
// re-grade within --max-retries — falls back to the source's verbatim imperative,
// a guaranteed-faithful floor (a substring of source cannot invert). Overridable
// for the recovery experiment: "retighten" re-runs the same blind compression that
// caused the inversion (the prior behavior); "repair" is judge-guided only, no
// floor; "repair-verbatim" is the full ladder and the default.
type WfRecovery = "retighten" | "repair" | "repair-verbatim";
const WF_RECOVERY: WfRecovery = ((): WfRecovery => {
  const v = process.env.DISTILL_WF_RECOVERY;
  return v === "retighten" || v === "repair" ? v : "repair-verbatim";
})();

// Glossary-def scope. A def's contract is definition-only: the connective prose
// carries the RELATIONS (subsumes/contrasts/precondition) and the rationale, while
// the `## Glossary` table carries what each concept IS. But synth and the fidelity
// gate historically held a def to its whole source block — folding relation-edges
// into the def and round-tripping it against rationale the prose was meant to carry,
// which bloated defs 3–4×. Two levers, each overridable for the def-scope experiment:
//   DISTILL_DEF_RELATIONS: "drop" (default) keeps relations OUT of the def; "keep"
//     folds them in (the prior behavior).
//   DISTILL_DEF_GATE: "definition" (default) grades a def for definitional content
//     only, letting relations/rationale ride the prose; "block" round-trips it against
//     the whole source block (the prior behavior).
const DEF_RELATIONS: "keep" | "drop" =
  process.env.DISTILL_DEF_RELATIONS === "keep" ? "keep" : "drop";
const DEF_GATE: "block" | "definition" =
  process.env.DISTILL_DEF_GATE === "block" ? "block" : "definition";

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
// A relation is one STRUCTURAL edge (D29): `rel` an open hyphenated token, `to` an
// endpoint (a bare local term-slug or a [[file-slug]] wikilink), `predicate` an
// optional one-clause gloss (null when none). The from-label is NOT a field — it is
// the entry's own `term`, supplied by the assembler (emitRelationsBlock).
type Relation = { rel: string; to: string; predicate: string | null };
type GlossEntry = { term: string; def: string; relations: Relation[]; source: string[] };
// a workflow step is an ACTIONABLE directive the note prescribes (a practice, a
// procedure step) — the procedural sink the glossary (concepts) cannot hold. The
// step carries a source-stated reason ("do X because Y") when the source gives
// one; the gate tolerates a dropped reason but forbids an invented one.
type WorkStep = { step: string; source: string[] };
type IR = { description: string; thesis: string; glossary: GlossEntry[]; workflow: WorkStep[] };

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

const glossList = (entries: { term: string; def: string }[]): string =>
  entries.map((e) => `- ${e.term}: ${e.def}`).join("\n");

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
// glyphs (curly quotes, a non-breaking hyphen) regardless of prompt instruction;
// this maps the finite set back. Em dashes (—) are kept as clause breaks (the
// source notes use them) but normalized to spaced form ( — ), since the model
// emits them tight (model—assuming) about half the time. It touches only
// substitutes — it leaves Cyrillic and source guillemets alone, safe for RU.
function normalizeTypography(s: string): string {
  return s
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–]/g, "-") // hyphen/nbhyphen/figure/en (ranges) → bare - (em dash — is kept)
    .replace(/[ \t]*[—―][ \t]*/g, " — ") // em dash / bar → spaced em dash; never eats a newline
    .replace(/…/g, "...")
    .replace(/ /g, " "); // nbsp → space
}

// Slug a single label — TS-native mirror of vault-query slug.rs::segment /
// normalize_segment (the unified slugifier). Strip wikilink syntax (keeping an
// alias over its target), drop backtick/`*`/`_`, lowercase, collapse every run of
// non-alphanumerics (Unicode letters+digits, so Cyrillic survives) to a single
// `-`, trim leading/trailing `-`. A second cross-language duplication (REL_REGISTRY
// is the first); the round-trip fixture pins it. BUILD emits PRE-slugified labels so
// the `## Relations` block is byte-stable for the REBUILD parser.
export function slugSegment(s: string): string {
  const stripped = s.replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_m, target, alias) =>
    alias != null && alias !== "" ? alias : target,
  );
  return stripped
    .replace(/[`*_]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

// Render a structural relation as readable `rel :: to (predicate)` for the
// prose-synth prompts — they only need a human-readable form of the edge, not the
// emit grammar. Used wherever relations were previously joined as bare strings.
const relText = (r: Relation): string =>
  `${r.rel} :: ${r.to}${r.predicate ? ` (${r.predicate})` : ""}`;

// Coerce one extracted relation into a typed edge. LOSSY (D29): keep every
// well-formed edge — drop ONLY when `rel` or `to` is missing. An unknown rel or an
// unresolved endpoint is a REBUILD lint finding, never a BUILD drop. Relations skip
// revise(), so typography is normalized here. The rel is lowercased and hyphenated
// (residual space-forms like "precondition for" → "precondition-for") so the open
// token matches the registry's shape; predicate is null when empty.
function normalizeRelation(r: unknown): Relation | null {
  if (!r || typeof r !== "object") return null;
  const o = r as { rel?: unknown; to?: unknown; predicate?: unknown };
  const rel = normalizeTypography(String(o.rel ?? ""))
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
  const to = normalizeTypography(String(o.to ?? "")).trim();
  if (!rel || !to) return null;
  const pred = o.predicate == null ? "" : normalizeTypography(String(o.predicate)).trim();
  return { rel, to, predicate: pred || null };
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

// Pull the frontmatter `type:` value (note / card / reference / …). distill never
// authors `type` and today never emits a reference body, so this feeds ONLY the D30
// defensive guard: a future reference-distill path must stay link-free (no `##
// Relations` block in a type:reference body). Returns "" when absent.
function parseType(front: string): string {
  const m = front.match(/^type:[ \t]*(.+)$/m);
  if (!m) return "";
  return m[1]
    .trim()
    .replace(/^["']|["']$/g, "")
    .toLowerCase();
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
  // Retry once on a PARSE failure (distinct from fw's network/5xx retry): the
  // FIDELITY thinking model sometimes returns only reasoning with no JSON object,
  // which extractJson rejects. It is non-deterministic, so a second call usually
  // complies — cheaper than dropping the whole run to the passthrough failsafe.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await fw(model, [{ role: "user", content: prompt }], { json: true, maxTokens });
    try {
      return JSON.parse(extractJson(raw)) as T;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// distill generates new natural-language text (abstractive), so every prompt must
// pin the output language to the note's own — else a Russian note distills to English.
const langName = (lang: "en" | "ru"): string => (lang === "ru" ? "Russian" : "English");
const langRule = (lang: "en" | "ru"): string =>
  `Write every natural-language value (description, thesis, term, def, relations, step, prose) in ${langName(lang)} — match the note's own language. Keep code, paths, identifiers, and [[wikilink]] targets verbatim.`;

// ---- stage 1: extract the combo (description, thesis, glossary) ----
function extractComboPrompt(blocks: Block[], frontDescription: string, lang: "en" | "ru"): string {
  const descRule = frontDescription
    ? `Use this authored description VERBATIM: "${frontDescription}"`
    : `Write ONE sentence naming what the note is about.`;
  return `You are a concept cartographer. Read the note below (block IDs in [Bn] markers) and produce its compressed idea-graph as JSON. ${langRule(lang)}
- "description": ${descRule}
- "thesis": the single spine claim the whole note argues, one sentence.
- "glossary": the note's LOAD-BEARING concepts — the named ideas a reader must hold to follow the thesis. Typically 4-10, NOT every noun phrase. A concept earns an entry only if the note both NAMES and DEFINES it; leave passing sentences, one-off examples, and restating clauses out of the glossary. For each: "term" (the concept's name), "def" (dense, in YOUR OWN words, <=20 words), "relations" (array of OBJECTS naming how it ties to OTHER terms; each {"rel","to","predicate"}: "rel" is a single hyphenated token (e.g. subsumes, precondition-for, contrast-to), "to" is EITHER a bare term-slug naming ANOTHER glossary term in this note OR a [[file-slug]] wikilink, "predicate" is an optional one-clause gloss or null — use null when there is no gloss; NOT a bare restatement of def), "source" (array of [Bn] id strings where it is defined or used, at least one).
- "workflow": the note's ACTIONABLE directives — the practices, steps, or procedure the note tells the reader to DO, in the order the note gives them. A directive earns an entry only when the note PRESCRIBES an action (an imperative, a practice, a "do X / avoid Y"); descriptive claims, explanations, and definitions are NOT directives — leave them to the thesis and glossary. For each: "step" (one imperative clause in YOUR OWN words, dense; if the SOURCE gives a reason for the action — "do X because Y", "do X so that Y" — append that source-stated reason to the step; if the source states no reason, keep the step terse), "source" (array of [Bn] id strings where it is prescribed, at least one). Use [] when the note is purely expository and prescribes nothing.
Collapse restatements of the SAME concept into ONE entry whose "source" lists all the blocks that state it — do not emit a separate entry per surface form.
Return ONLY JSON {"description":"...","thesis":"...","glossary":[{"term":"...","def":"...","relations":[{"rel":"...","to":"...","predicate":null}],"source":["Bn"]}],"workflow":[{"step":"...","source":["Bn"]}]}.

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
      // relations skip revise(), so coerce + normalize here (the extractor emits
      // non-breaking hyphens / typeset glyphs the same way the revise model does).
      // LOSSY (D29): drop only edges missing rel or to; keep unknown rels / unresolved
      // endpoints (those are REBUILD lint findings, not BUILD drops).
      relations: (Array.isArray(e.relations) ? e.relations : [])
        .map((r) => normalizeRelation(r))
        .filter((r): r is Relation => r !== null),
      source: (e.source ?? []).filter((id) => ids.has(id)),
    }))
    // an entry with no valid source block cannot be rendered grounded or graded — drop it
    .filter((e) => e.term && e.source.length > 0);
  const workflow = (ir.workflow ?? [])
    .map((s) => ({
      step: (s.step ?? "").trim(),
      source: (s.source ?? []).filter((id) => ids.has(id)),
    }))
    // a step with no valid source block cannot be grounded or gated — drop it
    .filter((s) => s.step && s.source.length > 0);
  // the authored frontmatter description overrides the model's: the one anchor never paraphrased
  const description = frontDescription || (ir.description ?? "").trim();
  return { description, thesis: (ir.thesis ?? "").trim(), glossary, workflow };
}

// ---- stage 2: grade each block drop / distill / retain ----
function gradeBlocksPrompt(ir: IR, blocks: Block[]): string {
  const gloss = glossList(ir.glossary);
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

function sourceTextFor(entry: { source: string[] }, blockById: Map<string, Block>): string {
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
    // DEF_RELATIONS=drop withholds the relations list so the def-writer cannot fold
    // edges in; the connective prose carries them. DEF_RELATIONS=keep is prior behavior.
    const concepts = entries
      .map((e) =>
        DEF_RELATIONS === "keep"
          ? `### ${e.term}\nrelations: ${e.relations.map(relText).join("; ")}\nSOURCE:\n${sourceTextFor(e, blockById)}`
          : `### ${e.term}\nSOURCE:\n${sourceTextFor(e, blockById)}`,
      )
      .join("\n\n");
    const relRule =
      DEF_RELATIONS === "keep"
        ? "Keep every named relation; use only claims the source states."
        : "Define the concept ITSELF — what it is — and state how it relates to other terms (subsumes / contrasts / precondition for) NOWHERE in the def; the connective prose carries relations. Use only claims the source states.";
    return `You are writing glossary definitions for a compressed note. For each concept, write its "def" grounded in the SOURCE text provided for it — but RE-EXPRESS it densely in your own words (<=20 words, one clause), compressing rather than copying a source sentence verbatim. ${relRule} Keep \`inline code\`, file paths, and ⟦N⟧ tokens verbatim. ${langRule(lang)} Return ONLY JSON {"entries":[{"term":"...","def":"..."}]} — one per concept, terms matching.

CONCEPTS:
${concepts}`;
  }
  const concepts = entries
    .map((e) =>
      DEF_RELATIONS === "keep"
        ? `### ${e.term}\ndef(draft): ${e.def}\nrelations: ${e.relations.map(relText).join("; ")}`
        : `### ${e.term}\ndef(draft): ${e.def}`,
    )
    .join("\n\n");
  const defRule =
    DEF_RELATIONS === "keep"
      ? 'write a maximally dense "def" that preserves its relations'
      : 'write a maximally dense "def" that defines the concept itself, stating no relations to other terms (the prose carries those)';
  return `You are writing glossary definitions for a compressed note from its extracted idea-graph alone. For each concept, ${defRule}. Stay on the thesis; introduce NO new concept. ${langRule(lang)} Return ONLY JSON {"entries":[{"term":"...","def":"..."}]} — one per concept, terms matching.

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

// ---- stage 3 (workflow): tighten each directive, preserve order, drop none ----
// Parallel to synthEntries on the procedural channel. The fidelity dial applies
// the same way: `render` grounds each tightened step in its source block(s);
// `regenerate` tightens from the extracted draft alone. Steps are keyed by index
// (S0, S1, …) since, unlike glossary terms, they have no natural unique name.
function synthWorkflowPrompt(
  steps: WorkStep[],
  mode: Synth,
  blockById: Map<string, Block>,
  lang: "en" | "ru",
): string {
  if (mode === "render") {
    // Show each step's own DRAFT alongside its SOURCE. Steps in a list share one
    // source block, so the draft is what individuates them — without it the model
    // sees N identical sources and collapses them to one directive.
    const items = steps
      .map((s, i) => `### S${i}\ndraft: ${s.step}\nSOURCE:\n${sourceTextFor(s, blockById)}`)
      .join("\n\n");
    return `You are tightening the procedure of a note into a clean ordered checklist. Each step has its own DRAFT directive and the SOURCE it came from. Tighten EACH draft into ONE dense imperative directive, keeping its distinct action and grounding it in the SOURCE — reword rather than copy a source sentence verbatim, keep steps separate, one action per step. If the draft carries a reason the SOURCE states ("because/so that Y"), keep that reason in the tightened step and add only reasons the source gives. Keep EVERY step (drop none) and preserve their order. Keep \`inline code\`, file paths, flags, and [[wikilink]] targets verbatim. ${langRule(lang)} Return ONLY JSON {"steps":[{"id":"S0","step":"..."}]} — one per step, ids matching.

STEPS:
${items}`;
  }
  const items = steps.map((s, i) => `### S${i}\ndraft: ${s.step}`).join("\n\n");
  return `You are tightening the procedure of a note into a clean ordered checklist from its drafted steps alone. For each step, write ONE dense imperative directive that preserves its action and any reason already in the draft, adding only reasons the draft carries. Keep EVERY step (drop none) and preserve their order. ${langRule(lang)} Return ONLY JSON {"steps":[{"id":"S0","step":"..."}]} — one per step, ids matching.

STEPS:
${items}`;
}

async function synthWorkflow(
  steps: WorkStep[],
  mode: Synth,
  blockById: Map<string, Block>,
  lang: "en" | "ru",
): Promise<string[]> {
  const out = steps.map((s) => s.step); // fall back to the extracted draft
  if (steps.length === 0) return out;
  try {
    const res = await askJson<{ steps: { id: string; step: string }[] }>(
      EXTRACT,
      synthWorkflowPrompt(steps, mode, blockById, lang),
      4096,
    );
    for (const e of res.steps ?? []) {
      const m = /^S(\d+)$/.exec((e.id ?? "").trim());
      if (m && e.step) {
        const idx = parseInt(m[1], 10);
        if (idx >= 0 && idx < out.length) out[idx] = e.step.trim();
      }
    }
  } catch {
    // a failed synth keeps the drafted steps (never silent-dropped)
  }
  return out;
}

// ---- stage-5 recovery: judge-guided repair of a flagged workflow group ----
// Unlike synthWorkflow (which re-applies the same compression that inverted the
// step), repair feeds the gate's own FINDING back, naming the violated direction
// so the rewrite fixes exactly that. Keyed by local index within the group.
function repairWorkflowGroupPrompt(
  steps: string[],
  missing: string,
  sourceText: string,
  lang: "en" | "ru",
): string {
  const items = steps.map((s, i) => `S${i}: ${s}`).join("\n");
  return `You are repairing a procedure checklist that an independent fidelity judge flagged as unfaithful to its source. You see the SOURCE (verbatim prescriptive text from the note), the current OUTPUT STEPS, and the JUDGE'S FINDING naming the dropped or inverted action. Rewrite the OUTPUT STEPS so the finding is resolved: follow the SOURCE's own direction exactly — when the source prescribes one target and rules out another ("do X, NOT Y"), keep X as the target and never name Y as the thing to do. Keep each step's action and any reason the SOURCE states, keep EVERY step (drop none), preserve order, stay dense and imperative. Keep \`inline code\`, file paths, flags, and [[wikilink]] targets verbatim. ${langRule(lang)} Return ONLY JSON {"steps":[{"id":"S0","step":"..."}]} — one per step, ids matching.

JUDGE'S FINDING: ${missing || "a prescribed action is dropped or inverted"}

SOURCE:
${sourceText}

OUTPUT STEPS:
${items}`;
}

async function repairWorkflowGroup(
  steps: string[],
  missing: string,
  sourceText: string,
  lang: "en" | "ru",
): Promise<string[]> {
  const out = [...steps]; // fall back to the flagged steps if repair fails to parse
  if (steps.length === 0) return out;
  try {
    const res = await askJson<{ steps: { id: string; step: string }[] }>(
      EXTRACT,
      repairWorkflowGroupPrompt(steps, missing, sourceText, lang),
      4096,
    );
    for (const e of res.steps ?? []) {
      const m = /^S(\d+)$/.exec((e.id ?? "").trim());
      if (m && e.step) {
        const idx = parseInt(m[1], 10);
        if (idx >= 0 && idx < out.length) out[idx] = e.step.trim();
      }
    }
  } catch {
    // a failed repair keeps the flagged steps; the gate re-grades them next
  }
  return out;
}

// Extract the source's own imperative clause(s) for the verbatim fallback: prefer
// the bolded directive spans the note emphasizes (notes bold their directives),
// else the first sentence of the block. The terminal floor when the repair ladder
// cannot clear a flagged group — the result is a literal substring of source, so
// it covers the action and cannot invent or invert.
function verbatimDirectives(sourceText: string): string[] {
  const bold = [...sourceText.matchAll(/\*\*([\s\S]+?)\*\*/g)]
    .map((m) => m[1].replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0);
  if (bold.length) return bold;
  const first = sourceText
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+/)[0]
    ?.trim();
  return first ? [first] : [];
}

// single-entry render from source — used by stage-5 recovery to re-ground a residue def
function renderEntryPrompt(entry: GlossEntry, sourceText: string, lang: "en" | "ru"): string {
  const relRule =
    DEF_RELATIONS === "keep"
      ? `keep every relation (${entry.relations.map(relText).join("; ")}); use only claims the source states.`
      : `define the concept itself; state no relations to other terms (the connective prose carries those); use only claims the source states.`;
  return `Write the glossary definition for "${entry.term}" using ONLY the source text below. One dense sentence; ${relRule} ${langRule(lang)} Return ONLY JSON {"def":"..."}.

SOURCE:
${sourceText}`;
}

function tieTogetherPrompt(ir: IR, lang: "en" | "ru"): string {
  const gloss = glossList(ir.glossary);
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

// ---- the connective prose (default mode's readable body) ----
// Writes the note's readable body as flowing prose. Division of labor: the prose
// carries the RELATIONS (how terms tie together) and the thesis; the definitions
// live in the `## Glossary` table below, so the prose names each term but does NOT
// restate its full definition. The definitions are shown to the model only as
// context (so it places terms correctly), with an explicit instruction not to copy
// them in. Relations are the spine the paragraphs are built on.
function connectiveProsePrompt(
  ir: IR,
  orderedEntries: GlossEntry[],
  defByTerm: Map<string, string>,
  lang: "en" | "ru",
): string {
  const concepts = orderedEntries
    .map(
      (e) =>
        `### ${e.term}\nrelations: ${e.relations.map(relText).join("; ")}\ndef (context only — do NOT restate in the prose): ${defByTerm.get(e.term) ?? e.def}`,
    )
    .join("\n\n");
  return `You are writing the readable body of a note. Its definitions live in a separate "## Glossary" table directly below your prose, which the reader can consult — so your job is the connective tissue, not the definitions. Write flowing prose (connected markdown paragraphs) that develops how the terms relate to one another, building on the relations listed for each concept. Bold each glossary term on its first mention (e.g. **Target distance**) so the bold marks it as a term defined in the glossary below; leave its full definition to the glossary table; add a brief gloss only where the flow needs it.
Write about the SUBJECT, not about the document: open the FIRST sentence by asserting the thesis directly as a plain claim about the subject (e.g. "Target distance is the gap between …, closed only by …"). NEVER refer to "the note", "this note", "the thesis", "this concept", "the author", or describe what the text does — state every point as a fact about the subject itself.
Use only claims, terms, and relations the input states. Do NOT emit a glossary, a table, a bullet list of the terms, or section headings. Keep \`inline code\`, file paths, and [[wikilink]] targets verbatim. ${langRule(lang)} Return ONLY JSON {"prose":"..."}.

THESIS (assert this in your own words as the opening claim — do not announce it as "the thesis"): ${ir.thesis}

CONCEPTS (term, its relations, and its definition for context):
${concepts}`;
}

async function connectiveProse(
  ir: IR,
  orderedEntries: GlossEntry[],
  defByTerm: Map<string, string>,
  lang: "en" | "ru",
): Promise<string> {
  if (orderedEntries.length === 0) return "";
  try {
    const res = await askJson<{ prose: string }>(
      EXTRACT,
      connectiveProsePrompt(ir, orderedEntries, defByTerm, lang),
      4096,
    );
    return (res.prose ?? "").trim() || ir.thesis;
  } catch {
    return ir.thesis; // a failed render degrades to the bare thesis sentence
  }
}

// ---- prose QA: an independent judge for the connective prose ----
// The prose is the un-gated readable head; it carries its own contract from
// connectiveProsePrompt (thesis-first opening, no document self-reference, no
// closing meta-summary, no AI vocabulary) that the generic revise pass enforces
// unreliably. A DIFFERENT model than the writer (the FIDELITY model judges the
// EXTRACT model's prose, mirroring the fidelity gate) flags those defects; one
// fix pass repairs them. This sits BELOW the fidelity line — prose defects never
// block output, they are repaired best-effort.
function proseJudgePrompt(thesis: string, prose: string): string {
  return `You are an independent prose editor. You did NOT write this text. Judge ONLY these four defects and ignore everything else:
1. CLOSING META-SUMMARY: a final paragraph that summarizes, ties together, or comments on the preceding text ("Thus, the interplay of these concepts...", "In summary...", "Together, these ideas...") rather than stating a fact about the subject.
2. DOCUMENT SELF-REFERENCE: any mention of "the note", "this note", "the text", "the thesis", "this concept", "the author", or any description of what the text itself does.
3. AI VOCABULARY: interplay, tapestry, underscore, delve, leverage, robust, intricate, navigate, realm, landscape, multifaceted, seamless, pivotal, and similar.
4. OPENING: the FIRST sentence must assert the thesis as a plain claim about the subject; flag it if instead it announces the topic ("This covers...", "Here we explore...").
Return ONLY JSON {"pass":true|false,"issues":["specific located finding", ...]}. pass=true ONLY when there are zero defects. Each issue names the exact offending span and which defect it is.

THESIS: ${thesis}

PROSE:
${prose}`;
}

async function proseJudge(
  thesis: string,
  prose: string,
): Promise<{ pass: boolean; issues: string[] }> {
  try {
    const r = await askJson<{ pass?: boolean; issues?: string[] }>(
      FIDELITY,
      proseJudgePrompt(thesis, prose),
      FIDELITY_TOKENS,
    );
    return {
      pass: r.pass !== false,
      issues: (r.issues ?? []).filter((s) => typeof s === "string"),
    };
  } catch {
    return { pass: true, issues: [] }; // a failed judge never blocks the prose
  }
}

// The fix pass is NOT revise(): revise is forbidden from dropping content, but a
// closing meta-summary must be DELETED, not reworded. This pass permits deletion
// while freezing every claim, bold term span, and verbatim token.
function proseFixPrompt(prose: string, issues: string[], lang: "en" | "ru"): string {
  return `You are a copy editor. Rewrite the PROSE below to fix EXACTLY these issues and change nothing else. You MAY delete whole sentences or paragraphs that are pure meta-summary or AI filler — for a closing summary paragraph, deletion is preferred over rewording. Preserve every factual claim about the subject, keep the thesis-first opening, and reproduce all **bold** term spans, \`inline code\`, file paths, and [[wikilink]] targets verbatim. ${langRule(lang)} Return ONLY JSON {"prose":"..."}.

ISSUES:
${issues.map((s) => `- ${s}`).join("\n")}

PROSE:
${prose}`;
}

async function proseFix(prose: string, issues: string[], lang: "en" | "ru"): Promise<string> {
  try {
    const r = await askJson<{ prose?: string }>(EXTRACT, proseFixPrompt(prose, issues, lang), 4096);
    return (r.prose ?? "").trim() || prose; // an empty fix keeps the prior prose
  } catch {
    return prose; // a failed fix keeps the prior prose
  }
}

// ---- writing passes (stage 4): reuse cut's four sequential rewrites ----
function revisePrompt(blocks: Block[], pass: Pass): string {
  return `You are a copy editor. This is the ${pass.name.toUpperCase()} pass. Revise each block below applying only the rules below. Preserve its claims, keep all its content, and match the original's structure exactly (same headings, bullets, and formatting). Keep code blocks verbatim, and reproduce any ⟦N⟧ placeholder tokens unchanged. Preserve emphasis (**bold**, _italic_). Write straight quotes; keep em dashes (—) as written. Return ONLY JSON {"blocks":[{"id":"B1","text":"revised text"}, ...]} — one entry per block, ids matching.

${pass.rules}

TEXT:
${render(blocks)}`;
}

async function revise(blocks: Block[], passes: Pass[], literals: string[] = []): Promise<Block[]> {
  // Mask reference spans ([[wikilinks]], ![[embeds]], inline code) to opaque ⟦N⟧
  // tokens before the passes so the rewriting model cannot reword or drop them;
  // restored verbatim at the end. General emphasis is left unmasked (it spans words
  // that legitimately get reworded) and relies on the prompt instruction instead.
  // `literals` are exact spans to freeze too — the bolded glossary terms (**Term**),
  // so the term text stays verbatim and keeps matching its glossary key.
  const masks = new Map<string, string>();
  const litToken = new Map<string, string>();
  let n = 0;
  // freeze the literal spans first (longest first, so a term that contains another
  // is masked whole before its substring), then the reference-span regex.
  const orderedLiterals = [...new Set(literals.filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  const maskLiterals = (text: string): string => {
    let out = text;
    for (const lit of orderedLiterals) {
      if (!out.includes(lit)) continue;
      let key = litToken.get(lit);
      if (!key) {
        key = `⟦${n++}⟧`;
        litToken.set(lit, key);
        masks.set(key, lit);
      }
      out = out.split(lit).join(key);
    }
    return out;
  };
  const mask = (text: string): string =>
    maskLiterals(text).replace(MASK_RE, (m) => {
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
// "inconclusive" is never emitted by the model — the gate functions assign it when
// the judge returns no parseable verdict (no JSON after askJson's retry). It is kept
// distinct from "residue": inconclusive items skip recovery (re-rendering cannot fix
// a judge that will not parse) and surface directly, so a flake never discards the run.
type Concept = {
  term: string;
  grade: "translated" | "residue" | "inconclusive";
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
  const criterion =
    DEF_GATE === "block"
      ? `Decide round-trip entailment in BOTH directions:
- does OUTPUT entail SOURCE (nothing load-bearing dropped)?
- does SOURCE entail OUTPUT (nothing invented)?
Grade "translated" if both hold; "residue" if either fails — name the direction ("output-misses-source" or "output-invents") and what is missing or invented.`
      : `The OUTPUT is a DEFINITION of the concept. How it relates to other terms (subsumes / contrasts / precondition for), the rationale or "why", and examples are carried by the note's surrounding prose, NOT by the definition — a def that omits any of them is NEVER missing. Judge only the definitional content, in BOTH directions:
- does OUTPUT capture what the SOURCE says the concept IS (nothing DEFINITIONAL dropped)? Omitting a relation, a reason, or an example is allowed, not missing.
- does SOURCE entail OUTPUT (nothing invented — no claim absent from the source)?
Grade "translated" if both hold; "residue" if either fails — name the direction ("output-misses-source" or "output-invents") and the definitional content missing or invented.`;
  return `You are an independent fidelity judge. You did NOT write this compression. For EACH concept you see its SOURCE (verbatim from the original note) and its OUTPUT (the compressed definition). ${criterion}
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
  try {
    const res = await askJson<{ thesisRecoverable?: boolean; concepts?: Concept[] }>(
      FIDELITY,
      fidelityPrompt(thesis, outputBody, rendered),
      FIDELITY_TOKENS,
    );
    return {
      thesisRecoverable: res.thesisRecoverable !== false,
      concepts: (res.concepts ?? []).filter((c) => c.term),
    };
  } catch {
    // judge returned no parseable verdict: mark every concept inconclusive (not
    // residue) so each ships surfaced-but-unverified rather than discarding the run.
    // thesisRecoverable stays optimistic — a parse flake is no evidence against it.
    return {
      thesisRecoverable: true,
      concepts: rendered.map((r) => ({
        term: r.term,
        grade: "inconclusive" as const,
        direction: "",
        missing: "judge returned no verdict",
      })),
    };
  }
}

// ---- workflow gate: directive coverage, NOT bidirectional def↔source ----
// A step's fidelity unit differs from a glossary entry's. Steps that share a
// source block (a practices/procedure list is one block) are judged as a SET
// against that block: every directive in the source must appear as some step
// (coverage) and every step must trace to a source directive (no invention).
// Crucially, rationale, explanation, and examples the steps omit do NOT count as
// missing — a checklist is allowed to drop the "why". A step may CARRY a reason
// when the source states one (extraction appends it), but the gate forbids
// INVENTING a reason the source does not give. So the unit is asymmetric: an
// action must be covered and uninvented (total on directives); a reason may be
// dropped freely but never fabricated (invention-only on the "why").
type StepVerdict = {
  id: string;
  grade: "translated" | "residue" | "inconclusive";
  missing: string;
};

function workflowGatePrompt(
  groups: { id: string; steps: string[]; sourceText: string }[],
  lang: "en" | "ru",
): string {
  const blocks = groups
    .map(
      (g) =>
        `### ${g.id}\nSOURCE:\n${g.sourceText}\nOUTPUT STEPS:\n${g.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
    )
    .join("\n\n");
  return `You are an independent fidelity judge for a procedure checklist. You did NOT write it. For each GROUP you see the SOURCE (verbatim prescriptive text from the original note) and the OUTPUT STEPS (tightened directives). Judge only the DIRECTIVES:
- COVERAGE: does every distinct action the SOURCE prescribes appear as one of the OUTPUT STEPS? An action dropped entirely is "residue".
- NO INVENTION (action): does every OUTPUT STEP correspond to an action the SOURCE prescribes? A step prescribing something the source does not is "residue".
- NO INVENTION (reason): a step MAY carry a reason ("because/so that Y"). Grade it "residue" only when that reason is NOT stated in the SOURCE — a step that states a reason the source gives is fine; a step that invents a reason the source does not give is "residue".
A checklist is ALLOWED to omit the source's rationale, explanation, examples, and "why" — omitting a reason the source gives is NEVER missing. The asymmetry: an action must be both covered and uninvented; a reason may be dropped freely but never invented. Judge actions and any stated reasons, not prose. ${langRule(lang)}
Grade "translated" when coverage holds and nothing is invented; else "residue", naming the dropped or invented action in "missing".
Return ONLY JSON {"groups":[{"id":"...","grade":"translated|residue","missing":"..."}]} — echo each group's id.

GROUPS:
${blocks}`;
}

async function workflowGate(
  groups: { id: string; steps: string[]; sourceText: string }[],
  lang: "en" | "ru",
): Promise<StepVerdict[]> {
  if (groups.length === 0) return [];
  try {
    const res = await askJson<{ groups?: StepVerdict[] }>(
      FIDELITY,
      workflowGatePrompt(groups, lang),
      FIDELITY_TOKENS,
    );
    return (res.groups ?? []).filter((g) => g.id);
  } catch {
    // judge returned no parseable verdict: mark every group inconclusive (not
    // residue) so the steps ship surfaced-but-unverified rather than discarding the run.
    return groups.map((g) => ({
      id: g.id,
      grade: "inconclusive" as const,
      missing: "judge returned no verdict",
    }));
  }
}

// ---- assembly: head prose + glossary table + retained-verbatim blocks ----
// `head` is the prose that sits above the table: the full connective note in the
// default mode (relations live here), or the short tie-together in --core-only.
// The `## Glossary` table carries definitions only — relations are not a column;
// they are carried by the connective prose (see connectiveProse).
function escCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}

const escAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

// Build the `## Relations` block body (D29 structural channel). One markdown list
// item per edge, in entry order then each entry's relation order. A single-atom card
// (orderedEntries.length === 1) OMITS the from-label, emitting `- <rel>:: <endpoint>`;
// a multi-node note PREFIXES each edge with the source entry's own slug as the
// from-label. Endpoint scope is marked by brackets: a `[[file-slug]]` stays a
// wikilink (inner re-slugged), a bare label becomes a local term-slug. Labels are
// pre-slugified so the block is byte-stable. Exported for isolated unit testing.
// Returns "" when no entry carries an edge.
export function emitRelationsBlock(orderedEntries: GlossEntry[]): string {
  const singleAtom = orderedEntries.length === 1;
  const lines: string[] = [];
  for (const entry of orderedEntries) {
    for (const r of entry.relations) {
      const wl = /^\[\[(.+)\]\]$/.exec(r.to.trim());
      const endpoint = wl ? `[[${slugSegment(wl[1])}]]` : slugSegment(r.to);
      if (!endpoint) continue; // an endpoint that slugs to empty is unrenderable
      const pred = r.predicate ? ` (${r.predicate})` : "";
      lines.push(
        singleAtom
          ? `- ${r.rel}:: ${endpoint}${pred}`
          : `- ${slugSegment(entry.term)} ${r.rel}:: ${endpoint}${pred}`,
      );
    }
  }
  return lines.length ? `## Relations\n\n${lines.join("\n")}` : "";
}

function assembleBody(
  h1: string,
  head: string,
  workflowSteps: string[],
  orderedEntries: GlossEntry[],
  defByTerm: Map<string, string>,
  retained: Block[],
  isReference: boolean,
): string {
  const parts: string[] = [];
  if (h1) parts.push(h1);
  if (head) parts.push(head);
  if (workflowSteps.length) {
    // filter empties before numbering: the verbatim fallback blanks surplus slots
    // when a group's source yields fewer directive clauses than it had draft steps,
    // so renumber over what remains rather than emitting a gap.
    const items = workflowSteps
      .map((s) => s.replace(/\n+/g, " ").trim())
      .filter(Boolean)
      .map((s, i) => `${i + 1}. ${s}`)
      .join("\n");
    if (items) parts.push(`## Workflow\n\n${items}`);
  }
  if (orderedEntries.length) {
    const rows = orderedEntries
      .map((e) => `| ${escCell(e.term)} | ${escCell(defByTerm.get(e.term) ?? e.def)} |`)
      .join("\n");
    parts.push(`## Glossary\n\n| Term | Definition |\n| ---- | ---------- |\n${rows}`);
  }
  // D30: a type:reference body stays link-free — never emit a `## Relations` block
  // into one. distill emits no references today, so this guard is currently a no-op
  // kept for a future reference-distill path. Section order = push order.
  if (!isReference) {
    const rel = emitRelationsBlock(orderedEntries);
    if (rel) parts.push(rel);
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
// skipped, `\|` unescaped, the inverse of escCell + assembleBody), and the
// preserved tail (everything else after the head: a `## Workflow` section, a
// wikilink reference list, …). Order-independent: the glossary may sit before or
// after the workflow section. The glossary table is the only region reconstructed
// into prose; every other section is passed through verbatim, so a `## Workflow`
// list is never folded into the prose regardless of where it appears.
function parseDistilled(body: string): {
  tie: string;
  entries: { term: string; def: string }[];
  preserved: string;
} {
  const lines = body.split("\n");
  const isHeading = (s: string) => /^##\s/.test(s.trim());
  const glossLine = lines.findIndex((l) => /^##\s+Glossary\b/i.test(l.trim()));
  if (glossLine < 0) {
    return { tie: stripH1(body).trim(), entries: [], preserved: "" };
  }
  // head: everything before the FIRST `## ` section (prose may precede a workflow
  // section that itself precedes the glossary). tie is that head minus any H1.
  let firstHeading = lines.findIndex(isHeading);
  if (firstHeading < 0) firstHeading = glossLine;
  const head = lines.slice(0, firstHeading).join("\n");
  // the glossary table: contiguous `|` rows after the glossary heading
  const rows: string[] = [];
  let j = glossLine + 1;
  for (; j < lines.length; j++) {
    const t = lines[j].trim();
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
  // preserved = the sections between head and the glossary heading + everything
  // after the glossary table, with the glossary heading+table region excised.
  const before = lines.slice(firstHeading, glossLine).join("\n").trim();
  const after = lines.slice(j).join("\n").trim();
  const preserved = [before, after].filter(Boolean).join("\n\n");
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
  return { tie: stripH1(head).trim(), entries, preserved };
}

function renderPrompt(
  description: string,
  tie: string,
  entries: { term: string; def: string }[],
  lang: "en" | "ru",
): string {
  const gloss = glossList(entries);
  return `You are reconstructing a readable prose note from its distilled glossary. Write flowing prose (connected markdown paragraphs) using ONLY the description, thesis, and glossary definitions below, drawing every claim, term, and example from them. Do NOT emit a glossary, a table, a bullet list of the terms, or section headings; write paragraphs a reader follows start to finish. Lead with the thesis, then develop each concept and how it relates to the others. ${langRule(lang)} Return ONLY JSON {"prose":"..."}.

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
    const { tie, entries, preserved } = parseDistilled(body);
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
    const outBody = preserved ? `${prose}\n\n${preserved}` : prose;
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
  opts: {
    synth: Synth;
    maxRetries: number;
    noRevise: boolean;
    noGate: boolean;
    coreOnly: boolean;
    isReference: boolean;
  },
): Promise<{ out: string; footer: string; residue: Residue[] }> {
  const passes = lang === "ru" ? PASS_RU : PASS_EN;
  const blocks = segment(text);
  const blockById = new Map(blocks.map((b) => [b.id, b]));
  const blockIndex = new Map(blocks.map((b, i) => [b.id, i]));
  const beforeWords = wordCount(text);

  // 1. extract combo
  const ir = await extractCombo(blocks, frontDescription, lang);
  if (ir.glossary.length === 0 && ir.workflow.length === 0) {
    // nothing to distill: no concepts and no directives. Passthrough, footer notes it.
    return { out: text, footer: `— nothing to distill · ${beforeWords} words`, residue: [] };
  }

  // 2. grade blocks
  const grades = await gradeBlocks(ir, blocks);
  const retained = blocks.filter((b) => grades.get(b.id) === "retain");
  const retainedIds = new Set(retained.map((b) => b.id));

  // order entries by first appearance of their lowest source block (note's own order)
  const orderKey = (e: { source: string[] }) =>
    Math.min(...e.source.map((id) => blockIndex.get(id) ?? 1e9));
  const orderedEntries = [...ir.glossary].sort((a, b) => orderKey(a) - orderKey(b));

  // a step whose every source block is retained verbatim is already carried by that
  // block — drop it so the directive is not duplicated as both a fence and a step.
  // The rest keep the note's order (Array.sort is stable across a shared block).
  const orderedSteps = ir.workflow
    .filter((s) => !s.source.every((id) => retainedIds.has(id)))
    .sort((a, b) => orderKey(a) - orderKey(b));

  // 3. synthesize definitions via the dial and the short tie-together (the gate's
  // thesis anchor, and the head in --core-only). These two are independent, so
  // they run concurrently; the connective prose body needs the defs, so it follows.
  const [defByTerm, tieResult, workflowSynth] = await Promise.all([
    synthEntries(ir, orderedEntries, opts.synth, blockById, lang),
    tieTogether(ir, lang),
    synthWorkflow(orderedSteps, opts.synth, blockById, lang),
  ]);
  let tie = tieResult;
  let workflowSteps = workflowSynth;
  let prose = opts.coreOnly ? "" : await connectiveProse(ir, orderedEntries, defByTerm, lang);

  // 4. revise the distilled prose (tie + connective prose + each def), structure untouched
  if (!opts.noRevise) {
    const dblocks: Block[] = [
      { id: "__TIE__", text: tie },
      ...(prose ? [{ id: "__PROSE__", text: prose }] : []),
      ...orderedEntries.map((e, i) => ({
        id: `__G${i}__`,
        text: defByTerm.get(e.term) ?? e.def,
      })),
      ...workflowSteps.map((s, i) => ({ id: `__W${i}__`, text: s })),
    ];
    // freeze the bolded glossary terms so revise keeps each term's text (and bold)
    // verbatim — the prose bolds them as glossary cross-references.
    const termLiterals = orderedEntries.map((e) => `**${e.term}**`);
    const rev = await revise(dblocks, passes, termLiterals);
    const byId = new Map(rev.map((b) => [b.id, b.text]));
    tie = byId.get("__TIE__") ?? tie;
    if (prose) prose = byId.get("__PROSE__") ?? prose;
    orderedEntries.forEach((e, i) => {
      const t = byId.get(`__G${i}__`);
      if (t) defByTerm.set(e.term, t);
    });
    workflowSteps = workflowSteps.map((s, i) => byId.get(`__W${i}__`) ?? s);
  }

  const h1 = blocks.find((b) => /^#\s/.test(b.text))?.text.split("\n")[0] ?? "";
  // The gate certifies the GLOSSARY form (tie + definitions), never the prose —
  // the prose is the un-gated readable derivative, and feeding it to the judge
  // made it mark every terse def as "missing" the detail the prose elaborates.
  // Gate `gloss`; build the final `out` (prose head by default) after recovery.
  let gloss = assembleBody(
    h1,
    tie,
    workflowSteps,
    orderedEntries,
    defByTerm,
    retained,
    opts.isReference,
  );

  // group steps by their shared source block-set so the workflow gate judges them
  // the way they exist: a practices/procedure list (one block) is one group whose
  // steps are judged as a set against that block; steps in distinct blocks each
  // form their own group, giving per-step granularity where the note allows it.
  const stepGroups = (() => {
    const by = new Map<string, number[]>();
    orderedSteps.forEach((s, i) => {
      const sig = [...new Set(s.source)].sort().join("|");
      const g = by.get(sig);
      if (g) g.push(i);
      else by.set(sig, [i]);
    });
    return [...by.entries()].map(([sig, idxs], n) => ({
      id: `workflow:${n + 1}`,
      idxs,
      sourceText: sourceTextFor({ source: sig.split("|") }, blockById),
    }));
  })();

  // 5. fidelity gate + recovery. Two criteria, two gates, one shared retry loop:
  // concepts round-trip bidirectionally against source (a def must capture the whole
  // concept); workflow groups are judged for directive coverage only (a checklist
  // may drop rationale). Both re-render failing items from source, capped.
  const residue: Residue[] = [];
  let retries = 0;
  let gateSkipped = 0;
  let keptVerbatim = 0;
  if (!opts.noGate) {
    const renderedC = () =>
      orderedEntries.map((e) => ({
        term: e.term,
        def: defByTerm.get(e.term) ?? e.def,
        sourceText: sourceTextFor(e, blockById),
      }));
    const renderedG = () =>
      stepGroups.map((g) => ({
        id: g.id,
        steps: g.idxs.map((i) => workflowSteps[i]),
        sourceText: g.sourceText,
      }));
    const [graded, gradedG] = await Promise.all([
      fidelityGate(ir.thesis, gloss, renderedC()),
      workflowGate(renderedG(), lang),
    ]);
    const thesisRecoverable = graded.thesisRecoverable;
    // inconclusive verdicts (judge returned no JSON) are set aside from the start:
    // recovery cannot fix them, so they bypass the retry loop and surface directly.
    const inconclusiveC = new Map<string, Concept>();
    const inconclusiveG = new Map<string, StepVerdict>();
    for (const c of graded.concepts) if (c.grade === "inconclusive") inconclusiveC.set(c.term, c);
    for (const g of gradedG) if (g.grade === "inconclusive") inconclusiveG.set(g.id, g);
    let failC = graded.concepts.filter((c) => c.grade === "residue");
    let failG = gradedG.filter((g) => g.grade === "residue");
    while ((failC.length > 0 || failG.length > 0) && retries < opts.maxRetries) {
      retries++;
      // re-render failing concepts/groups from source, regardless of dial; items are
      // independent, so concurrent. Recovery bypasses revise(), so normalize here.
      await Promise.all([
        ...failC.map(async (c) => {
          const entry = orderedEntries.find((e) => e.term === c.term);
          if (!entry) return;
          try {
            const r = await askJson<{ def: string }>(
              EXTRACT,
              renderEntryPrompt(entry, sourceTextFor(entry, blockById), lang),
              1024,
            );
            if (r.def) defByTerm.set(entry.term, normalizeTypography(r.def.trim()));
          } catch {
            // a failed re-render keeps the prior def; the gate re-grades it next
          }
        }),
        ...failG.map(async (v) => {
          const g = stepGroups.find((x) => x.id === v.id);
          if (!g) return;
          try {
            if (WF_RECOVERY === "retighten") {
              // re-tighten the whole group from source (drafts individuate the steps).
              // Same compression pressure that inverted the step — kept for the experiment.
              const tightened = await synthWorkflow(
                g.idxs.map((i) => orderedSteps[i]),
                "render",
                blockById,
                lang,
              );
              g.idxs.forEach((i, k) => {
                if (tightened[k]) workflowSteps[i] = normalizeTypography(tightened[k]);
              });
            } else {
              // judge-guided repair: feed the gate's finding back so the rewrite fixes
              // the named inversion instead of re-running the compression that caused it
              const repaired = await repairWorkflowGroup(
                g.idxs.map((i) => workflowSteps[i]),
                v.missing,
                g.sourceText,
                lang,
              );
              g.idxs.forEach((i, k) => {
                if (repaired[k]) workflowSteps[i] = normalizeTypography(repaired[k]);
              });
            }
          } catch {
            // a failed re-render keeps the prior steps; the gate re-grades them next
          }
        }),
      ]);
      gloss = assembleBody(
        h1,
        tie,
        workflowSteps,
        orderedEntries,
        defByTerm,
        retained,
        opts.isReference,
      );
      // re-grade only the patched items, not the full set (budget)
      const patchC = new Set(failC.map((c) => c.term));
      const patchG = new Set(failG.map((g) => g.id));
      const [reg, regG] = await Promise.all([
        patchC.size
          ? fidelityGate(
              ir.thesis,
              gloss,
              renderedC().filter((r) => patchC.has(r.term)),
            )
          : Promise.resolve({ thesisRecoverable, concepts: [] as Concept[] }),
        patchG.size
          ? workflowGate(
              renderedG().filter((r) => patchG.has(r.id)),
              lang,
            )
          : Promise.resolve([] as StepVerdict[]),
      ]);
      // a re-grade can itself come back inconclusive — capture those too, then drop
      // them from the recoverable sets so the loop never retries an unparseable verdict.
      for (const c of reg.concepts) if (c.grade === "inconclusive") inconclusiveC.set(c.term, c);
      for (const g of regG) if (g.grade === "inconclusive") inconclusiveG.set(g.id, g);
      failC = reg.concepts.filter((c) => c.grade === "residue");
      failG = regG.filter((g) => g.grade === "residue");
    }
    // verbatim fallback: a workflow group the repair ladder could not clear ships
    // the source's own imperative verbatim. The clause is a literal substring of
    // source, so it covers the action and cannot invert — the inversion clears at
    // the cost of a slightly verbose step, which beats shipping it inverted. Groups
    // whose source yields no extractable clause stay in failG and surface as residue.
    if (WF_RECOVERY === "repair-verbatim" && failG.length) {
      const stillFail: StepVerdict[] = [];
      for (const v of failG) {
        const g = stepGroups.find((x) => x.id === v.id);
        const verb = g ? verbatimDirectives(g.sourceText) : [];
        if (g && verb.length) {
          g.idxs.forEach((idx, k) => {
            // pair clauses to slots in order; the last slot absorbs any overflow,
            // surplus slots blank out (filtered when the Workflow list renders).
            workflowSteps[idx] =
              k < verb.length
                ? k === g.idxs.length - 1 && verb.length > g.idxs.length
                  ? verb.slice(k).join("; ")
                  : verb[k]
                : "";
          });
          keptVerbatim++;
        } else {
          stillFail.push(v);
        }
      }
      failG = stillFail;
      if (keptVerbatim) {
        gloss = assembleBody(
          h1,
          tie,
          workflowSteps,
          orderedEntries,
          defByTerm,
          retained,
          opts.isReference,
        );
      }
    }
    // surviving residue (incl. an unrecoverable thesis) is surfaced, never silent
    for (const c of failC) {
      const entry = orderedEntries.find((e) => e.term === c.term);
      residue.push({
        term: c.term,
        reason: `${c.direction || "residue"}: ${c.missing || "failed round-trip entailment"}`,
        source: entry ? sourceTextFor(entry, blockById) : "",
      });
    }
    for (const v of failG) {
      const g = stepGroups.find((x) => x.id === v.id);
      residue.push({
        term: v.id,
        reason: `workflow: ${v.missing || "directive coverage failed"}`,
        source: g ? g.sourceText : "",
      });
    }
    if (!thesisRecoverable) {
      residue.unshift({
        term: "(thesis)",
        reason: "thesis not recoverable from output",
        source: ir.thesis,
      });
    }
    // gate-inconclusive items: the judge could not render a verdict (no JSON after
    // retry). Ship them surfaced-but-unverified, distinct from genuine residue, so a
    // judge flake never discards the run — the floor under the passthrough failsafe.
    for (const c of inconclusiveC.values()) {
      const entry = orderedEntries.find((e) => e.term === c.term);
      residue.push({
        term: c.term,
        reason: `gate-inconclusive: ${c.missing || "judge returned no verdict"}`,
        source: entry ? sourceTextFor(entry, blockById) : "",
      });
    }
    for (const v of inconclusiveG.values()) {
      const g = stepGroups.find((x) => x.id === v.id);
      residue.push({
        term: v.id,
        reason: `gate-inconclusive: ${v.missing || "judge returned no verdict"}`,
        source: g ? g.sourceText : "",
      });
    }
    gateSkipped = inconclusiveC.size + inconclusiveG.size;
  }

  // prose QA: judge the un-gated readable head against its own contract and
  // repair best-effort. Rides the --no-gate switch; no-op in --core-only (no
  // prose). One judge + one fix pass — defects never block, so no re-judge.
  let proseFixes = 0;
  if (prose && !opts.noGate) {
    const pj = await proseJudge(ir.thesis, prose);
    if (!pj.pass && pj.issues.length) {
      proseFixes = pj.issues.length;
      prose = await proseFix(prose, pj.issues, lang);
    }
  }

  // assemble the final output: the connective prose head by default, the tie in
  // --core-only. Definitions are the gate-settled ones; the prose restates none
  // of them, so recovery changing a def never invalidates the prose above it.
  const out = assembleBody(
    h1,
    opts.coreOnly ? tie : prose,
    workflowSteps,
    orderedEntries,
    defByTerm,
    retained,
    opts.isReference,
  );

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
  const proseTag = proseFixes ? ` · ${proseFixes} prose fixes` : "";
  const stepsTag = orderedSteps.length ? ` · ${orderedSteps.length} steps` : "";
  // gate-skipped items are a subset of residue.length — flag them so a batch log
  // distinguishes "judge couldn't verify" from a genuine fidelity miss.
  const gateTag = gateSkipped ? ` · ${gateSkipped} gate-skipped` : "";
  // steps the repair ladder could not clear and that shipped the source's verbatim
  // imperative — faithful but uncompressed, distinct from a cleared step
  const verbatimTag = keptVerbatim ? ` · ${keptVerbatim} kept-verbatim` : "";
  const shapeTag = opts.coreOnly ? "gloss" : "prose+gloss";
  const footer = `— distilled ${shapeTag} · ${beforeWords}→${afterWords} words (${sizeTag}) · ${orderedEntries.length} entries${stepsTag} · ${retained.length} verbatim · ${residue.length} residue${gateTag}${verbatimTag}${retriesTag}${proseTag}`;
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
  coreOnly: boolean;
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
    coreOnly: argv.includes("--core-only"),
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
    coreOnly,
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
  // D30: a type:reference body must stay link-free (no ## Relations). distill emits
  // no references today, so this only future-proofs a reference-distill path.
  const isReference = parseType(front) === "reference";
  try {
    const { out, footer, residue } = await distill(body, resolved, frontDescription, {
      synth,
      maxRetries,
      noRevise,
      noGate,
      coreOnly,
      isReference,
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

// Guard the CLI entrypoint so test imports (e.g. distill.test.ts importing
// REL_REGISTRY) can load this module without running the pipeline against stdin.
if (import.meta.main) main();
