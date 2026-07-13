// prompts — the LLM stages: every prompt builder and the async stage function that
// calls it. Each stage maps a typed input to a typed output through fw's askJson;
// the pipeline (pipeline.ts) sequences them. The writing-core stages (the four
// writing passes and the prose judge/fix) moved to writing/ and are re-exported
// below for callers that still import them from here.
import {
  type Block,
  type Grade,
  type GlossEntry,
  type Combo,
  type Inference,
  type Judgement,
  type LinkInventory,
  type ProseUnit,
  type Relation,
  type WorkStep,
  glossList,
  hasOperational,
  hasWikilink,
  isContentfulStep,
  langRule,
  normalizeRelation,
  relText,
  render,
} from "./text.ts";
import { askJson, EXTRACT, EXTRACT_TOKENS, FIDELITY, FIDELITY_TOKENS, rethrowIfBug } from "./fw.ts";
import type { Modality, PreEdge, PreGraph, PreUnit } from "./graph.ts";
export { type Pass, PASS_EN, PASS_RU, revise } from "./writing/passes.ts";
export { proseJudge, proseFix } from "./writing/prose-qa.ts";

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

// ---- stage 1: extract the combo (description, thesis, glossary) ----
// Render the deterministic link inventory as a MUST-COVER checklist appended to the
// prompt: every [[wikilink]] the harvest found (the classify-into-three-lanes answer
// key) plus every external [text](url) (the citation lane, kept OUT of relations). The
// instruction text is always English — langRule pins the OUTPUT values' language, and a
// quoted predicate is a verbatim source span already in the note's language. Returns ""
// when the note has no links, so a link-free note keeps the original lean prompt.
function linkInventorySection(inventory: LinkInventory, selfSlug: string): string {
  if (inventory.wikilinks.length === 0 && inventory.external.length === 0) return "";
  const self = selfSlug.trim();
  const wl = inventory.wikilinks.length
    ? inventory.wikilinks.map((w) => `  - ${w.markup}`).join("\n")
    : "  (none)";
  const ex = inventory.external.length
    ? inventory.external.map((e) => `  - ${e.markup}`).join("\n")
    : "  (none)";
  // The SELF slug is the classification anchor: it lets the model recognize a link
  // back to the note itself and route it correctly. The note-level emit lane is gone —
  // every hostless link is a SEE-ALSO, never a fabricated cross-note edge.
  return `

SELF: this note's own slug is ${self ? `[[${self}]]` : "(unresolved)"}.
LINK INVENTORY (a MUST-COVER checklist — classify EVERY vault link below into EXACTLY ONE lane; omit none):
${wl}
Each entry is a vault link ([[wikilink]] or [text](path.md)) the note states. Assign each to exactly one lane:
1. TERM-SCOPED edge — the link's target IS one of the glossary terms above: encode it as that term's "relations" entry with "to" set to the bare term-slug.
2. NOTE-LEVEL edge — UNAVAILABLE for this note: treat every hostless link as SEE-ALSO instead.
3. SEE-ALSO — every other link: an associative mention with no stated directional relation. Do NOT emit a relation for it; leave it in place for the curator's see-also list.
A link that fails the note-level test stays SEE-ALSO. NEVER fabricate a "rel" to type an associative link: if no directional predicate is quotable from the prose, the link is SEE-ALSO, not an edge. The quoted predicate is the audit trail — without a quotable directional phrase, do not emit a note-level edge.
EXTERNAL LINKS (citations / sources, NOT vault relations — NEVER encode a URL as a relation; leave them in the prose as the sources they cite):
${ex}`;
}

export function extractComboPrompt(
  blocks: Block[],
  frontDescription: string,
  lang: "en" | "ru",
  inventory: LinkInventory = { wikilinks: [], external: [] },
  selfSlug = "",
): string {
  const descRule = frontDescription
    ? `Use this authored description VERBATIM: "${frontDescription}"`
    : `Write ONE sentence naming what the note is about.`;
  return `You are a concept cartographer. Read the note below (block IDs in [Bn] markers) and produce its compressed idea-graph as JSON. ${langRule(lang)}
- "title": the note's own H1 title, or — if it has none — a short noun phrase naming its subject.
- "abstract": 1-2 sentences orienting a reader to what the note covers. This is a SYNTHESIZED overview — the ONE block that carries no source quote.
- "description": ${descRule}
- "thesis": the single spine claim the whole note argues, one sentence.
- "glossary": the note's LOAD-BEARING concepts — the named ideas a reader must hold to follow the thesis. Typically 4-10, NOT every noun phrase. A concept earns an entry only if the note both NAMES and DEFINES it; leave passing sentences, one-off examples, and restating clauses out of the glossary. For each: "term" (the concept's name), "def" (dense, in YOUR OWN words, <=20 words), "quote" (a VERBATIM source slice — see QUOTES), "relations" (array of OBJECTS naming how it ties to OTHER terms; each {"rel","to","predicate","quote"}: "rel" is a single hyphenated token (e.g. subsumes, precondition-for, contrast-to), "to" is EITHER a bare term-slug naming ANOTHER glossary term in this note OR a [[file-slug]] wikilink, "predicate" is an optional one-clause gloss or null — use null when there is no gloss; NOT a bare restatement of def; "quote" is a VERBATIM source slice — see QUOTES), "source" (array of [Bn] id strings where it is defined or used, at least one).
- "judgements": the note's stated JUDGEMENTS — claims it ASSERTS as true (an S-is-P assertion, an evaluation, a stance), distinct from the concepts they are about. For each: "statement" (the claim in one sentence, YOUR OWN words), "modality" (tag "hypothesis" ONLY when the note frames the claim as tentative/conjectural, "necessarily" ONLY when it frames it as a necessity/must/law; otherwise null — do NOT tag a plainly-asserted claim), "quote" (a VERBATIM source slice — see QUOTES), "source" (array of [Bn] id strings, at least one). Use [] when the note asserts no standalone judgements.
- "inferences": the note's stated INFERENCES — claims the note DERIVES from others (signalled by "therefore", "so", "which means", "it follows that"). For each: "statement" (the derived claim, one sentence, YOUR OWN words), "quote" (a VERBATIM source slice — see QUOTES), "source" (array of [Bn] id strings, at least one). Use [] when the note draws no explicit inferences.
- "workflow": the note's ACTIONABLE directives — the practices, steps, or procedure the note tells the reader to DO, in the order the note gives them. A directive earns an entry only when the note PRESCRIBES an action (an imperative, a practice, a "do X / avoid Y"); descriptive claims, explanations, and definitions are NOT directives — leave them to the thesis and glossary. For each: "step" (one imperative clause in YOUR OWN words, dense; if the SOURCE gives a reason for the action — "do X because Y", "do X so that Y" — append that source-stated reason to the step; if the source states no reason, keep the step terse), "quote" (a VERBATIM source slice — see QUOTES), "source" (array of [Bn] id strings where it is prescribed, at least one). Use [] when the note is purely expository and prescribes nothing.
QUOTES: every "quote" is a slice copied EXACTLY, character-for-character, from the block text it was distilled from — do NOT reword, translate, or normalize punctuation; keep the source's own glyphs. EXCLUDE the leading [Bn] marker. Make each quote long enough to occur EXACTLY ONCE in the note (add surrounding words if a short phrase would be ambiguous). The type of a unit is carried by WHICH array it lands in — never emit a "type" field.
Collapse restatements of the SAME concept into ONE entry whose "source" lists all the blocks that state it — do not emit a separate entry per surface form.
Return ONLY JSON {"title":"...","abstract":"...","description":"...","thesis":"...","glossary":[{"term":"...","def":"...","quote":"...","relations":[{"rel":"...","to":"...","predicate":null,"quote":"..."}],"source":["Bn"]}],"judgements":[{"statement":"...","modality":null,"quote":"...","source":["Bn"]}],"inferences":[{"statement":"...","quote":"...","source":["Bn"]}],"workflow":[{"step":"...","quote":"...","source":["Bn"]}]}.
${linkInventorySection(inventory, selfSlug)}

TEXT (block IDs in [Bn] markers):
${render(blocks)}`;
}

// Normalize the raw extract JSON into a typed Combo — the PURE core of extractCombo,
// exported so it is testable without a network round-trip. Threads the verbatim `quote`
// onto every glossary entry, relation, and workflow step (trim only — NEVER
// normalizeTypography on a quote, it must stay byte-verbatim to round-trip against source
// in locate()); parses the judgement/inference channels; carries title/abstract; and
// applies the existing source-id validation + drop-if-no-source rule, extended to
// judgements and inferences. `frontDescription`, when set, overrides the model's
// description (the one anchor never paraphrased). All the new fields are additive: the
// shipped stages read only {glossary, workflow, thesis, description}.
export function parseExtractResult(raw: Combo, blocks: Block[], frontDescription = ""): Combo {
  const ids = new Set(blocks.map((b) => b.id));
  // Trim-only, byte-verbatim: a quote is the span-locate anchor, so it is never
  // typography-normalized. Returns `{ quote }` when present, `{}` when empty — spread
  // into the unit so an entry with no quote keeps the two-channel shape (no `quote` key).
  const quoteField = (q: unknown): { quote?: string } => {
    const s = typeof q === "string" ? q.trim() : "";
    return s ? { quote: s } : {};
  };
  const withSource = (s: unknown): string[] =>
    (Array.isArray(s) ? s : []).filter((id) => ids.has(id));
  const glossary = (raw.glossary ?? [])
    .map((e) => ({
      term: (e.term ?? "").trim(),
      def: (e.def ?? "").trim(),
      // relations skip revise(), so coerce + normalize here (the extractor emits
      // non-breaking hyphens / typeset glyphs the same way the revise model does).
      // LOSSY (D29): drop only edges missing rel or to; keep unknown rels / unresolved
      // endpoints (those are REBUILD lint findings, not BUILD drops). normalizeRelation
      // threads each relation's own verbatim quote (trim only).
      relations: (Array.isArray(e.relations) ? e.relations : [])
        .map((r) => normalizeRelation(r))
        .filter((r): r is Relation => r !== null),
      source: withSource(e.source),
      ...quoteField((e as { quote?: unknown }).quote),
    }))
    // an entry with no valid source block cannot be rendered grounded or graded — drop it
    .filter((e) => e.term && e.source.length > 0);
  const workflow = (raw.workflow ?? [])
    .map((s) => ({
      step: (s.step ?? "").trim(),
      source: withSource(s.source),
      ...quoteField((s as { quote?: unknown }).quote),
    }))
    // a step with no valid source block cannot be grounded or gated — drop it
    .filter((s) => s.step && s.source.length > 0);
  // judgement modality: accept only the two marked forms; anything else is assertoric (null)
  const modalityOf = (m: unknown): "hypothesis" | "necessarily" | null =>
    m === "hypothesis" || m === "necessarily" ? m : null;
  const judgements: Judgement[] = (raw.judgements ?? [])
    .map((j) => ({
      statement: (j.statement ?? "").trim(),
      modality: modalityOf(j.modality),
      source: withSource(j.source),
      ...quoteField((j as { quote?: unknown }).quote),
    }))
    // same drop-if-no-source rule as glossary/workflow: an unanchored judgement cannot be located
    .filter((j) => j.statement && j.source.length > 0);
  const inferences: Inference[] = (raw.inferences ?? [])
    .map((i) => ({
      statement: (i.statement ?? "").trim(),
      source: withSource(i.source),
      ...quoteField((i as { quote?: unknown }).quote),
    }))
    .filter((i) => i.statement && i.source.length > 0);
  // the authored frontmatter description overrides the model's: the one anchor never paraphrased
  const description = frontDescription || (raw.description ?? "").trim();
  return {
    description,
    thesis: (raw.thesis ?? "").trim(),
    glossary,
    workflow,
    title: (raw.title ?? "").trim(),
    abstract: (raw.abstract ?? "").trim(),
    judgements,
    inferences,
  };
}

export async function extractCombo(
  blocks: Block[],
  frontDescription: string,
  lang: "en" | "ru",
  inventory: LinkInventory = { wikilinks: [], external: [] },
  selfSlug = "",
): Promise<Combo> {
  const combo = await askJson<Combo>(
    EXTRACT,
    extractComboPrompt(blocks, frontDescription, lang, inventory, selfSlug),
    EXTRACT_TOKENS,
  );
  return parseExtractResult(combo, blocks, frontDescription);
}

// ---- canonical extract: native typed pre-graph (spec §4 step 1; blueprint §1.2/§1.4) ----
// The ADDITIVE replacement for extractComboPrompt/parseExtractResult. It emits the SAME five
// knowledge channels but shaped as the pre-graph (graph.ts PreGraph): `concepts`/`headword`/
// `statement` (was glossary/term/def), grouped `procedures` (was the flat workflow), and
// relations without `predicate` (the projection never renders it). The two SEMANTIC changes vs
// the Combo prompt: (1) `statement` is the FINAL normalized re-expression, not a draft the settle
// chain later rewrites; (2) procedures carry a `headword` + per-step quotes so the projector can
// render `### headword` + numbered steps. Payload is NOT a channel here — it is the deterministic
// retain lane (blueprint §1.1). Kept alongside the Combo prompt during migration; unwired until a
// later step flips distill()'s default path onto it.

// The raw JSON shape the model returns for the pre-graph prompt (parsed defensively — every field
// is optional, mirroring parseExtractResult's `(raw.x ?? [])` discipline).
export interface RawGraph {
  title?: string;
  abstract?: string;
  description?: string;
  thesis?: string;
  concepts?: {
    headword?: string;
    statement?: string;
    quote?: string;
    relations?: unknown[];
    source?: unknown;
  }[];
  judgements?: { statement?: string; modality?: unknown; quote?: string; source?: unknown }[];
  inferences?: { statement?: string; quote?: string; source?: unknown }[];
  procedures?: {
    headword?: string;
    steps?: { statement?: string; quote?: string; source?: unknown }[];
  }[];
}

export function extractGraphPrompt(
  blocks: Block[],
  frontDescription: string,
  lang: "en" | "ru",
  inventory: LinkInventory = { wikilinks: [], external: [] },
  selfSlug = "",
): string {
  const descRule = frontDescription
    ? `Use this authored description VERBATIM: "${frontDescription}"`
    : `Write ONE sentence naming what the note is about.`;
  return `You are a concept cartographer. Read the note below (block IDs in [Bn] markers) and produce its compressed idea-graph as JSON. ${langRule(lang)}
- "title": the note's own H1 title, or — if it has none — a short noun phrase naming its subject.
- "abstract": 1-2 sentences orienting a reader to what the note covers. This is a SYNTHESIZED overview — the ONE block that carries no source quote.
- "description": ${descRule}
- "thesis": the single spine claim the whole note argues, one sentence.
- "concepts": the note's LOAD-BEARING concepts — the named ideas a reader must hold to follow the thesis. Typically 4-10, NOT every noun phrase. A concept earns an entry only if the note both NAMES and DEFINES it; leave passing sentences, one-off examples, and restating clauses out. For each: "headword" (the concept's name), "statement" (the FINAL dense definition in YOUR OWN words, one clause — this is the definition the reader sees, not a draft; compress rather than copy a source sentence), "quote" (a VERBATIM source slice — see QUOTES), "relations" (array of OBJECTS naming how it ties to OTHER concepts; each {"rel","to","quote"}: "rel" is a single hyphenated token (e.g. subsumes, precondition-for, contrast-to), "to" is EITHER a bare headword-slug naming ANOTHER concept in this note OR a [[file-slug]] wikilink, "quote" is a VERBATIM source slice — see QUOTES), "source" (array of [Bn] id strings where it is defined or used, at least one).
- "judgements": the note's stated JUDGEMENTS — claims it ASSERTS as true (an S-is-P assertion, an evaluation, a stance), distinct from the concepts they are about. For each: "statement" (the claim in one sentence, YOUR OWN words), "modality" (tag "hypothesis" ONLY when the note frames the claim as tentative/conjectural, "necessarily" ONLY when it frames it as a necessity/must/law; otherwise null — do NOT tag a plainly-asserted claim), "quote" (a VERBATIM source slice — see QUOTES), "source" (array of [Bn] id strings, at least one). Use [] when the note asserts no standalone judgements.
- "inferences": the note's stated INFERENCES — claims the note DERIVES from others (signalled by "therefore", "so", "which means", "it follows that"). For each: "statement" (the derived claim, one sentence, YOUR OWN words), "quote" (a VERBATIM source slice — see QUOTES), "source" (array of [Bn] id strings, at least one). Use [] when the note draws no explicit inferences.
- "procedures": the note's ACTIONABLE procedures — grouped by the named procedure they belong to. A procedure earns an entry only when the note PRESCRIBES actions (imperatives, a practice, a "do X / avoid Y"); descriptive claims, explanations, and definitions are NOT directives. For each: "headword" (a short noun phrase naming the procedure), "steps" (array, IN THE ORDER the note gives them; each {"statement","quote","source"}: "statement" is ONE imperative clause in YOUR OWN words, dense — if the SOURCE gives a reason ("do X because Y") append it, else keep it terse; "quote" is a VERBATIM source slice — see QUOTES; "source" is an array of [Bn] id strings where it is prescribed, at least one). Use [] when the note is purely expository and prescribes nothing.
QUOTES: every "quote" is a slice copied EXACTLY, character-for-character, from the block text it was distilled from — do NOT reword, translate, or normalize punctuation; keep the source's own glyphs. EXCLUDE the leading [Bn] marker. Make each quote long enough to occur EXACTLY ONCE in the note (add surrounding words if a short phrase would be ambiguous). The type of a unit is carried by WHICH array it lands in — never emit a "type" field.
Collapse restatements of the SAME concept into ONE entry whose "source" lists all the blocks that state it — do not emit a separate entry per surface form.
Return ONLY JSON {"title":"...","abstract":"...","description":"...","thesis":"...","concepts":[{"headword":"...","statement":"...","quote":"...","relations":[{"rel":"...","to":"...","quote":"..."}],"source":["Bn"]}],"judgements":[{"statement":"...","modality":null,"quote":"...","source":["Bn"]}],"inferences":[{"statement":"...","quote":"...","source":["Bn"]}],"procedures":[{"headword":"...","steps":[{"statement":"...","quote":"...","source":["Bn"]}]}]}.
${linkInventorySection(inventory, selfSlug)}

TEXT (block IDs in [Bn] markers):
${render(blocks)}`;
}

// Normalize the raw pre-graph JSON into a typed PreGraph — the PURE core of extractGraph, exported
// so it is testable without a network round-trip. It keeps parseExtractResult's validation
// discipline: `quote` is trimmed byte-verbatim (NEVER typography-normalized — it is the span-locate
// anchor and must round-trip against source bytes), `source` ids are validated against the block
// set, the drop-if-no-valid-source rule holds per unit, relations pass through `normalizeRelation`
// (lowercase+hyphenate rel, trim to, trim-only quote; predicate DROPPED here), and judgement
// modality is clamped to the two marked forms (null → assertoric). `frontDescription`, when set,
// overrides the model's description (the one anchor never paraphrased). Spans are NOT computed here
// — the model emits no offsets; locateGraph turns each quote into a span (spec §4 step 2).
export function parseExtractGraph(raw: RawGraph, blocks: Block[], frontDescription = ""): PreGraph {
  const ids = new Set(blocks.map((b) => b.id));
  // Trim-only, byte-verbatim: a quote is the span-locate anchor, so it is never typography-
  // normalized. Empty → "" (a unit with no quote hard-aborts at locate — the fidelity gate).
  const quoteField = (q: unknown): string => (typeof q === "string" ? q.trim() : "");
  const withSource = (s: unknown): string[] =>
    (Array.isArray(s) ? s : []).filter((id) => ids.has(id));
  // judgement modality: accept only the two marked forms; anything else is assertoric.
  const modalityOf = (m: unknown): Modality =>
    m === "hypothesis" || m === "necessarily" ? m : "assertoric";

  // concepts → concept PreUnits (id = headword) + the flat edge list (each relation becomes a
  // PreEdge owned by the concept's headword). Drop a concept with no headword or no valid source
  // (it cannot be rendered grounded); its relations are dropped with it.
  const concepts: PreUnit[] = [];
  const edges: PreEdge[] = [];
  for (const c of raw.concepts ?? []) {
    const headword = (c.headword ?? "").trim();
    if (!headword || withSource(c.source).length === 0) continue;
    concepts.push({
      type: "concept",
      id: headword,
      statement: (c.statement ?? "").trim(),
      quote: quoteField(c.quote),
    });
    for (const r of Array.isArray(c.relations) ? c.relations : []) {
      const norm = normalizeRelation(r); // lossy (D29): drops only rel/to-missing; predicate dropped below
      if (!norm) continue;
      edges.push({ fromHeadword: headword, rel: norm.rel, to: norm.to, quote: norm.quote ?? "" });
    }
  }

  // judgement PreUnits (id ordinal, assigned at locate); same drop-if-no-source rule.
  const judgements: PreUnit[] = [];
  for (const j of raw.judgements ?? []) {
    const statement = (j.statement ?? "").trim();
    if (!statement || withSource(j.source).length === 0) continue;
    judgements.push({
      type: "judgment",
      statement,
      quote: quoteField(j.quote),
      modality: modalityOf(j.modality),
    });
  }

  // inference PreUnits (id ordinal, assigned at locate).
  const inferences: PreUnit[] = [];
  for (const inf of raw.inferences ?? []) {
    const statement = (inf.statement ?? "").trim();
    if (!statement || withSource(inf.source).length === 0) continue;
    inferences.push({ type: "inference", statement, quote: quoteField(inf.quote) });
  }

  // procedure groups: keep grounded steps in order; drop a group with no surviving step (the
  // headword may be "" — locate falls back to `Procedure N`).
  const procedures: { headword: string; steps: PreUnit[] }[] = [];
  for (const p of raw.procedures ?? []) {
    const steps: PreUnit[] = [];
    for (const s of Array.isArray(p.steps) ? p.steps : []) {
      const statement = (s.statement ?? "").trim();
      if (!statement || withSource(s.source).length === 0) continue;
      steps.push({ type: "procedure", statement, quote: quoteField(s.quote) });
    }
    if (steps.length === 0) continue;
    procedures.push({ headword: (p.headword ?? "").trim(), steps });
  }

  // the authored frontmatter description overrides the model's: the one anchor never paraphrased
  const description = frontDescription || (raw.description ?? "").trim();
  return {
    title: (raw.title ?? "").trim(),
    abstract: (raw.abstract ?? "").trim(),
    description,
    thesis: (raw.thesis ?? "").trim(),
    concepts,
    judgements,
    inferences,
    procedures,
    edges,
  };
}

export async function extractGraph(
  blocks: Block[],
  frontDescription: string,
  lang: "en" | "ru",
  inventory: LinkInventory = { wikilinks: [], external: [] },
  selfSlug = "",
): Promise<PreGraph> {
  const raw = await askJson<RawGraph>(
    EXTRACT,
    extractGraphPrompt(blocks, frontDescription, lang, inventory, selfSlug),
    EXTRACT_TOKENS,
  );
  return parseExtractGraph(raw, blocks, frontDescription);
}

// ---- stage 2: grade each block drop / distill / retain ----
// The payload retain lane (blueprint §1.1): the ONE deterministic selection that survives the
// settle-chain collapse. Reads a thesis + a concept list ({term,def}), NOT a `Combo` — the
// canonical default path feeds the pre-graph's concepts (id→term, statement→def) and the legacy
// paths feed `combo.thesis`/`combo.glossary` (a `GlossEntry` structurally satisfies {term,def}).
function gradeBlocksPrompt(
  thesis: string,
  concepts: { term: string; def: string }[],
  blocks: Block[],
): string {
  const gloss = glossList(concepts);
  return `You are grading each block of a note for an abstractive compression. You have the note's thesis and its glossary of concepts. Grade EVERY block:
- "drop": off-thesis, OR its content is already captured by a glossary entry (a restatement).
- "distill": on-thesis prose whose ideas should be re-expressed densely — it folds into the glossary and a short prose tie-together. This is the DEFAULT for explanatory text.
- "retain": ONLY content that is already compact and would be destroyed by rewording — a fenced code block, a command line, a file path, a flag, literal output, or a list made mostly of [[wikilink]] references (a "related"/"see also" list). Narrative or explanatory PROSE is NEVER "retain", even when it is important, names an example, or contains a [[wikilink]] — that prose is "distill". When unsure between distill and retain, choose distill.
Return ONLY JSON {"grades":[{"id":"Bn","grade":"drop|distill|retain"}]} — one entry per block, ids matching.

THESIS: ${thesis}

GLOSSARY:
${gloss}

BLOCKS (ids in [Bn] markers):
${render(blocks)}`;
}

export async function gradeBlocks(
  thesis: string,
  concepts: { term: string; def: string }[],
  blocks: Block[],
): Promise<Map<string, Grade>> {
  const judged = await askJson<{ grades: { id: string; grade: Grade }[] }>(
    EXTRACT,
    gradeBlocksPrompt(thesis, concepts, blocks),
    EXTRACT_TOKENS,
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

// ---- stage 3: synthesize glossary definitions (source-grounded) ----
// Each def is grounded in its cited source text. A `regenerate` arm (defs from the
// extracted idea-graph alone) existed as a fidelity dial until the 2026-06-25
// stability experiment refuted the tradeoff it embodied: render matched it on
// stability and restatement collapse and compressed MORE (60% vs 54%) — the
// already-lossy IR re-expands with hedging. See
// `35 experiments/2026-06-25-distill-synth-dial-stability.md` for what would
// justify re-adding it.

export function sourceTextFor(entry: { source: string[] }, blockById: Map<string, Block>): string {
  return entry.source
    .map((id) => blockById.get(id)?.text ?? "")
    .filter(Boolean)
    .join("\n---\n");
}

function synthEntriesPrompt(
  entries: GlossEntry[],
  blockById: Map<string, Block>,
  lang: "en" | "ru",
): string {
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

export async function synthEntries(
  entries: GlossEntry[],
  blockById: Map<string, Block>,
  lang: "en" | "ru",
): Promise<Map<string, string>> {
  const out = new Map<string, string>(entries.map((e) => [e.term, e.def])); // fall back to Combo def
  if (entries.length === 0) return out;
  const res = await askJson<{ entries: { term: string; def: string }[] }>(
    EXTRACT,
    synthEntriesPrompt(entries, blockById, lang),
    EXTRACT_TOKENS,
  );
  for (const e of res.entries ?? []) if (e.term && e.def) out.set(e.term.trim(), e.def.trim());
  return out;
}

// ---- stage 3 (workflow): tighten each directive, preserve order, drop none ----
// Parallel to synthEntries on the procedural channel: each tightened step is
// grounded in its source block(s). Steps are keyed by index (S0, S1, …) since,
// unlike glossary terms, they have no natural unique name.
function synthWorkflowPrompt(
  steps: WorkStep[],
  blockById: Map<string, Block>,
  lang: "en" | "ru",
): string {
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

export async function synthWorkflow(
  steps: WorkStep[],
  blockById: Map<string, Block>,
  lang: "en" | "ru",
): Promise<string[]> {
  const out = steps.map((s) => s.step); // fall back to the extracted draft
  if (steps.length === 0) return out;
  try {
    const res = await askJson<{ steps: { id: string; step: string }[] }>(
      EXTRACT,
      synthWorkflowPrompt(steps, blockById, lang),
      EXTRACT_TOKENS,
    );
    for (const e of res.steps ?? []) {
      const m = /^S(\d+)$/.exec((e.id ?? "").trim());
      // reject a marker-only "tightened" step (the model echoing an ordinal like "3."):
      // keep the extracted draft rather than overwrite real content with a list number.
      if (m && e.step && isContentfulStep(e.step)) {
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
      EXTRACT_TOKENS,
    );
    for (const e of res.steps ?? []) {
      const m = /^S(\d+)$/.exec((e.id ?? "").trim());
      // reject a marker-only "tightened" step (the model echoing an ordinal like "3."):
      // keep the extracted draft rather than overwrite real content with a list number.
      if (m && e.step && isContentfulStep(e.step)) {
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

// The def analogue of verbatimDirectives: the terminal floor when a checked
// `recover:` def fails the grade a SECOND time at apply (apply-mode.ts, Phase 4).
// The source's own defining clause — the first sentence naming the term
// (case-insensitive), else the first sentence — collapsed to one line for the
// glossary cell. A literal substring of source, so it cannot invert or invent;
// verbose where a translation would be tighter, which beats shipping an inverted def.
export function verbatimDef(term: string, sourceText: string): string {
  const flat = sourceText.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const sentences = flat.split(/(?<=[.!?])\s+/);
  const needle = term.toLowerCase();
  const hit = sentences.find((s) => s.toLowerCase().includes(needle));
  return (hit ?? sentences[0] ?? flat).trim();
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

function tieTogetherPrompt(combo: Combo, lang: "en" | "ru"): string {
  const gloss = glossList(combo.glossary);
  return `In 2-4 sentences, state the note's thesis and how its main glossary terms connect. Use only concepts already in the glossary. Plain declarative prose — no heading, no list. ${langRule(lang)} Return ONLY JSON {"prose":"..."}.

THESIS: ${combo.thesis}

GLOSSARY:
${gloss}`;
}

export async function tieTogether(combo: Combo, lang: "en" | "ru"): Promise<string> {
  if (combo.glossary.length === 0) return "";
  try {
    const res = await askJson<{ prose: string }>(EXTRACT, tieTogetherPrompt(combo, lang), 1024);
    return (res.prose ?? "").trim();
  } catch (e) {
    rethrowIfBug(e, "tieTogether");
    return combo.thesis; // a transient tie-together flake degrades to the bare thesis sentence
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
  combo: Combo,
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

THESIS (assert this in your own words as the opening claim — do not announce it as "the thesis"): ${combo.thesis}

CONCEPTS (term, its relations, and its definition for context):
${concepts}`;
}

export async function connectiveProse(
  combo: Combo,
  orderedEntries: GlossEntry[],
  defByTerm: Map<string, string>,
  lang: "en" | "ru",
): Promise<string> {
  if (orderedEntries.length === 0) return "";
  try {
    const res = await askJson<{ prose: string }>(
      EXTRACT,
      connectiveProsePrompt(combo, orderedEntries, defByTerm, lang),
      EXTRACT_TOKENS,
    );
    return (res.prose ?? "").trim() || combo.thesis;
  } catch (e) {
    rethrowIfBug(e, "connectiveProse");
    return combo.thesis; // a transient render flake degrades to the bare thesis sentence
  }
}

// ---- stage 5: fidelity gate (round-trip entailment, different model) ----
// "inconclusive" is never emitted by the model — the gate functions assign it when
// the judge returns no parseable verdict (no JSON after askJson's retry). It is kept
// distinct from "residue": inconclusive items skip recovery (re-rendering cannot fix
// a judge that will not parse) and surface directly, so a flake never discards the run.
export type ConceptVerdict = {
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
): Promise<{ thesisRecoverable: boolean; concepts: ConceptVerdict[] }> {
  try {
    const res = await askJson<{ thesisRecoverable?: boolean; concepts?: ConceptVerdict[] }>(
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

// ---- prose gate: list-item coverage (the prose-judge tier, D46) ----
// A deterministic inventory (text.ts::harvestProseListItems) is the answer key; glm — the
// DIFFERENT model from the one that wrote the compression — is the MATCHER ONLY, deciding
// per item whether its information SURVIVED somewhere in the output (covered) or was DROPPED.
// It never decides the key. A "covered" verdict must quote a verbatim output anchor; the
// covered→clear decision and the anchor re-check live in pipeline.ts::proseResidue, which
// DEFAULTS TO SURFACED for an omitted id, an unanchored covered, or a parse flake — the
// model that caused the loss never clears a span by silence.
export type ProseVerdict = {
  id: string;
  grade: "covered" | "dropped";
  anchor: string;
  missing: string;
};

function proseMatchPrompt(outputBody: string, units: ProseUnit[], lang: "en" | "ru"): string {
  const items = units
    .map((u) => `### ${u.id}\nFROM SECTION "${u.heading}":\n${u.span}`)
    .join("\n\n");
  return `You are an independent coverage judge. You did NOT write this compression — a different model did, and it was ALLOWED to compress, merge, paraphrase, re-author, and re-order freely. Below is the full compressed OUTPUT, then a list of ITEMS taken verbatim from the original note (each a single list entry). For EACH item decide ONE thing: did the item's INFORMATION survive ANYWHERE in the OUTPUT — in any compressed, paraphrased, merged-into-a-definition, or folded-into-prose form — (grade "covered"), or was it DROPPED entirely (grade "dropped")?
Rules:
- "covered" REQUIRES an anchor: quote in "anchor" a verbatim substring of at least 4 words copied from the OUTPUT, AND that quote must be the place where THIS item's information survives — not unrelated true text from elsewhere in the OUTPUT. If no such quotable OUTPUT substring exists, you may NOT grade it covered.
- An item is "covered" even if ALL its wording, examples, emphasis, and ordering are gone and only its CLAIM remains. Compression and re-authoring are NOT loss.
- "dropped" only when the item's information appears NOWHERE in the OUTPUT; name what is absent in "missing".
- Judge each item independently; never grade one covered because a sibling item was covered.
${langRule(lang)}
Return ONLY JSON {"units":[{"id":"...","grade":"covered|dropped","anchor":"<verbatim OUTPUT substring>","missing":"..."}]} — echo each id exactly once.

OUTPUT (the compressed note):
${outputBody}

ITEMS:
${items}`;
}

// Match the inventory against the output, in batches of 5 (each payload stays under
// FIDELITY_TOKENS). Returns the raw verdicts keyed by id plus the set of ids whose batch
// flaked (transient / no-parse), so proseResidue can surface a flaked id distinctly from one
// the judge simply omitted. The covered/dropped→residue MAPPING and anchor re-check are pure
// and live in pipeline.ts::proseResidue. A real bug propagates through rethrowIfBug.
// The batches are independent full-output matches, so they fire concurrently (mirrors the
// Promise.all over independent glm calls in runFidelityGate); the try/catch is PER batch so a
// flake flags only its own ids while a real bug rejects Promise.all and propagates.
export async function proseGate(
  units: ProseUnit[],
  outputBody: string,
  lang: "en" | "ru",
): Promise<{ verdicts: Map<string, ProseVerdict>; flaked: Set<string> }> {
  const verdicts = new Map<string, ProseVerdict>();
  const flaked = new Set<string>();
  const BATCH = 5;
  const batches: ProseUnit[][] = [];
  for (let i = 0; i < units.length; i += BATCH) batches.push(units.slice(i, i + BATCH));
  await Promise.all(
    batches.map(async (batch) => {
      try {
        const res = await askJson<{ units?: ProseVerdict[] }>(
          FIDELITY,
          proseMatchPrompt(outputBody, batch, lang),
          FIDELITY_TOKENS,
        );
        for (const v of res.units ?? []) if (v.id) verdicts.set(v.id, v);
      } catch (e) {
        rethrowIfBug(e, "proseGate");
        // transient / no-parse flake: leave this batch's ids un-verdicted AND flag them, so
        // proseResidue surfaces each as inconclusive — never silently cleared.
        for (const u of batch) flaked.add(u.id);
      }
    }),
  );
  return { verdicts, flaked };
}
