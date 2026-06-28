// prompts — the LLM stages: every prompt builder and the async stage function that
// calls it. Each stage maps a typed input to a typed output through fw's askJson;
// the pipeline (pipeline.ts) sequences them. Prompt-shaping config knobs and the
// writing-pass rubric live here too, beside the stages that read them.
import {
  type Block,
  type Grade,
  type GlossEntry,
  type IR,
  type Relation,
  type WorkStep,
  glossList,
  hasOperational,
  hasWikilink,
  langRule,
  MASK_RE,
  normalizeRelation,
  normalizeTypography,
  relText,
  render,
} from "./text.ts";
import { askJson, EXTRACT, FIDELITY, FIDELITY_TOKENS, rethrowIfBug } from "./fw.ts";

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
export type Pass = { name: string; rules: string };

export const PASS_EN: Pass[] = [
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

export const PASS_RU: Pass[] = [
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

export async function extractCombo(
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

export async function gradeBlocks(ir: IR, blocks: Block[]): Promise<Map<string, Grade>> {
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
export type Synth = "render" | "regenerate";

export function sourceTextFor(entry: { source: string[] }, blockById: Map<string, Block>): string {
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

export async function synthEntries(
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

export async function synthWorkflow(
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
  } catch (e) {
    rethrowIfBug(e, "synthWorkflow");
    // a transient synth flake keeps the drafted steps (never silent-dropped)
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

export async function repairWorkflowGroup(
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
  } catch (e) {
    rethrowIfBug(e, "repairWorkflowGroup");
    // a transient repair flake keeps the flagged steps; the gate re-grades them next
  }
  return out;
}

// Extract the source's own imperative clause(s) for the verbatim fallback: prefer
// the bolded directive spans the note emphasizes (notes bold their directives),
// else the first sentence of the block. The terminal floor when the repair ladder
// cannot clear a flagged group — the result is a literal substring of source, so
// it covers the action and cannot invent or invert.
export function verbatimDirectives(sourceText: string): string[] {
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
export function renderEntryPrompt(
  entry: GlossEntry,
  sourceText: string,
  lang: "en" | "ru",
): string {
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

export async function tieTogether(ir: IR, lang: "en" | "ru"): Promise<string> {
  if (ir.glossary.length === 0) return "";
  try {
    const res = await askJson<{ prose: string }>(EXTRACT, tieTogetherPrompt(ir, lang), 1024);
    return (res.prose ?? "").trim();
  } catch (e) {
    rethrowIfBug(e, "tieTogether");
    return ir.thesis; // a transient tie-together flake degrades to the bare thesis sentence
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

export async function connectiveProse(
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
  } catch (e) {
    rethrowIfBug(e, "connectiveProse");
    return ir.thesis; // a transient render flake degrades to the bare thesis sentence
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

export async function proseJudge(
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
  } catch (e) {
    rethrowIfBug(e, "proseJudge");
    return { pass: true, issues: [] }; // a transient judge flake never blocks the prose
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

export async function proseFix(
  prose: string,
  issues: string[],
  lang: "en" | "ru",
): Promise<string> {
  try {
    const r = await askJson<{ prose?: string }>(EXTRACT, proseFixPrompt(prose, issues, lang), 4096);
    return (r.prose ?? "").trim() || prose; // an empty fix keeps the prior prose
  } catch (e) {
    rethrowIfBug(e, "proseFix");
    return prose; // a transient fix flake keeps the prior prose
  }
}

// ---- writing passes (stage 4): reuse cut's four sequential rewrites ----
function revisePrompt(blocks: Block[], pass: Pass): string {
  return `You are a copy editor. This is the ${pass.name.toUpperCase()} pass. Revise each block below applying only the rules below. Preserve its claims, keep all its content, and match the original's structure exactly (same headings, bullets, and formatting). Keep code blocks verbatim, and reproduce any ⟦N⟧ placeholder tokens unchanged. Preserve emphasis (**bold**, _italic_). Write straight quotes; keep em dashes (—) as written. Return ONLY JSON {"blocks":[{"id":"B1","text":"revised text"}, ...]} — one entry per block, ids matching.

${pass.rules}

TEXT:
${render(blocks)}`;
}

export async function revise(
  blocks: Block[],
  passes: Pass[],
  literals: string[] = [],
): Promise<Block[]> {
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
    } catch (e) {
      rethrowIfBug(e, "revise");
      // a transient pass flake keeps the current blocks (see above); continue
    }
  }
  return cur.map((b) => ({ id: b.id, text: unmask(normalizeTypography(b.text)) }));
}

// ---- stage 5: fidelity gate (round-trip entailment, different model) ----
// "inconclusive" is never emitted by the model — the gate functions assign it when
// the judge returns no parseable verdict (no JSON after askJson's retry). It is kept
// distinct from "residue": inconclusive items skip recovery (re-rendering cannot fix
// a judge that will not parse) and surface directly, so a flake never discards the run.
export type Concept = {
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

export async function fidelityGate(
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
  } catch (e) {
    rethrowIfBug(e, "fidelityGate");
    // transient judge flake (no parseable verdict): mark every concept inconclusive
    // (not residue) so each ships surfaced-but-unverified rather than discarding the
    // run. thesisRecoverable stays optimistic — a parse flake is no evidence against it.
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
export type StepVerdict = {
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

export async function workflowGate(
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
  } catch (e) {
    rethrowIfBug(e, "workflowGate");
    // transient judge flake (no parseable verdict): mark every group inconclusive
    // (not residue) so the steps ship surfaced-but-unverified rather than discarding the run.
    return groups.map((g) => ({
      id: g.id,
      grade: "inconclusive" as const,
      missing: "judge returned no verdict",
    }));
  }
}
