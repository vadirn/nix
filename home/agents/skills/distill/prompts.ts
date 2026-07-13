// prompts — the LLM stages: every prompt builder and the async stage function that
// calls it. Each stage maps a typed input to a typed output through fw's askJson;
// the pipeline (pipeline.ts) sequences them. The writing-core passes moved to
// writing/passes.ts and are re-exported below for callers that still import them
// from here.
import {
  type Block,
  type Grade,
  type LinkInventory,
  type ProseUnit,
  glossList,
  hasOperational,
  hasWikilink,
  langRule,
  normalizeRelation,
  render,
} from "./text.ts";
import { askJson, EXTRACT, EXTRACT_TOKENS, FIDELITY, FIDELITY_TOKENS, rethrowIfBug } from "./fw.ts";
import type { Modality, PreEdge, PreGraph, PreUnit } from "./graph.ts";
export { type Pass, PASS_EN, PASS_RU, revise } from "./writing/passes.ts";

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

// ---- extract: the link-inventory checklist shared by the canonical extract prompt ----
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

// ---- canonical extract: native typed pre-graph (spec §4 step 1; blueprint §1.2/§1.4) ----
// The extractor's only prompt+parse path: it emits the five knowledge channels shaped as the
// pre-graph (graph.ts PreGraph): `concepts`/`headword`/`statement`, grouped `procedures` (steps
// grouped under a headword), and relations without `predicate` (the projection never renders
// it). `statement` is the FINAL normalized re-expression — extractGraph is the one place a
// unit's wording is authored; nothing downstream (locate, the typing review, the projector, the
// residue backstop) rewrites it. `procedures` carry a `headword` + per-step quotes so the
// projector can render `### headword` + numbered steps. Payload is NOT a channel here — it is
// the deterministic retain lane (blueprint §1.1), computed separately by gradeBlocks.

// The raw JSON shape the model returns for the pre-graph prompt (parsed defensively — every
// field is optional; a missing array defaults to `[]` rather than throwing).
export interface RawGraph {
  title?: string;
  abstract?: string;
  description?: string;
  thesis?: string;
  concepts?: {
    headword?: string;
    statement?: string;
    quote?: string;
    bullets?: { statement?: string; quote?: string }[];
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
- "concepts": the note's LOAD-BEARING concepts — the named ideas a reader must hold to follow the thesis. Typically 4-10, NOT every noun phrase. A concept earns an entry only if the note both NAMES and DEFINES it; leave passing sentences, one-off examples, and restating clauses out. For each: "headword" (the concept's name), "statement" (the FINAL dense definition in YOUR OWN words, one clause — this is the definition the reader sees, not a draft; compress rather than copy a source sentence), "quote" (a VERBATIM source slice — see QUOTES), "bullets" (OPTIONAL array — the concept's EXTENSION: the predicated properties or enumerated species the note states ABOUT this concept beyond its bare definition, each a SHORT clause; each {"statement","quote"}: "statement" is one clause in YOUR OWN words, "quote" is a VERBATIM source slice — see QUOTES; use [] or omit when the note states no such properties — do NOT invent a bullet the note does not state), "relations" (array of OBJECTS naming how it ties to OTHER concepts; each {"rel","to","quote"}: "rel" is a single hyphenated token (e.g. subsumes, precondition-for, contrast-to), "to" is EITHER a bare headword-slug naming ANOTHER concept in this note OR a [[file-slug]] wikilink, "quote" is a VERBATIM source slice — see QUOTES), "source" (array of [Bn] id strings where it is defined or used, at least one).
- "judgements": the note's stated JUDGEMENTS — claims it ASSERTS as true (an S-is-P assertion, an evaluation, a stance), distinct from the concepts they are about. For each: "statement" (the claim in one sentence, YOUR OWN words), "modality" — one of null | "hypothesis" | "necessarily" (tag "hypothesis" ONLY when the note frames the claim as tentative/conjectural; tag "necessarily" ONLY when the note frames it as a necessity/obligation/prohibition/law — watch for the modal words "must", "must not", "cannot", "may not", "shall", "always"/"never" used as a rule (e.g. a deontic clause such as "if you cannot state its use, you must not remove it" is tagged "necessarily" because "must not" frames it as a prohibition); otherwise null — do NOT tag a plainly-asserted claim that carries no such modal word, e.g. "the fence blocks the road" stays null), "quote" (a VERBATIM source slice — see QUOTES), "source" (array of [Bn] id strings, at least one). Use [] when the note asserts no standalone judgements.
- "inferences": the note's stated INFERENCES — claims the note DERIVES from others (signalled by "therefore", "so", "which means", "it follows that"). For each: "statement" (the derived claim, one sentence, YOUR OWN words), "quote" (a VERBATIM source slice — see QUOTES), "source" (array of [Bn] id strings, at least one). Use [] when the note draws no explicit inferences.
- "procedures": the note's ACTIONABLE procedures — grouped by the named procedure they belong to. A procedure earns an entry only when the note PRESCRIBES actions (imperatives, a practice, a "do X / avoid Y"); descriptive claims, explanations, and definitions are NOT directives. For each: "headword" (a short noun phrase naming the procedure), "steps" (array, IN THE ORDER the note gives them; each {"statement","quote","source"}: "statement" is ONE imperative clause in YOUR OWN words, dense — if the SOURCE gives a reason ("do X because Y") append it, else keep it terse; "quote" is a VERBATIM source slice — see QUOTES; "source" is an array of [Bn] id strings where it is prescribed, at least one). Use [] when the note is purely expository and prescribes nothing.
QUOTES: every "quote" is a slice copied EXACTLY, character-for-character, from the block text it was distilled from — do NOT reword, translate, or normalize punctuation; keep the source's own glyphs. EXCLUDE the leading [Bn] marker. Make each quote long enough to occur EXACTLY ONCE in the note (add surrounding words if a short phrase would be ambiguous). The type of a unit is carried by WHICH array it lands in — never emit a "type" field.
Collapse restatements of the SAME concept into ONE entry whose "source" lists all the blocks that state it — do not emit a separate entry per surface form.
Return ONLY JSON {"title":"...","abstract":"...","description":"...","thesis":"...","concepts":[{"headword":"...","statement":"...","quote":"...","bullets":[{"statement":"...","quote":"..."}],"relations":[{"rel":"...","to":"...","quote":"..."}],"source":["Bn"]}],"judgements":[{"statement":"...","modality":null|"hypothesis"|"necessarily","quote":"...","source":["Bn"]}],"inferences":[{"statement":"...","quote":"...","source":["Bn"]}],"procedures":[{"headword":"...","steps":[{"statement":"...","quote":"...","source":["Bn"]}]}]}.
${linkInventorySection(inventory, selfSlug)}

TEXT (block IDs in [Bn] markers):
${render(blocks)}`;
}

// Normalize the raw pre-graph JSON into a typed PreGraph — the PURE core of extractGraph, exported
// so it is testable without a network round-trip. Its validation discipline: `quote` is trimmed
// byte-verbatim (NEVER typography-normalized — it is the span-locate
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
    // extension bullets: keep those with a non-empty statement (the anchor `quote` may be empty —
    // that bullet then renders unanchored, mirroring an unquoted procedure step). Trim-only,
    // byte-verbatim quotes (the span-locate anchor), same discipline as the concept's own quote.
    const bullets = (Array.isArray(c.bullets) ? c.bullets : [])
      .map((b) => ({ statement: (b?.statement ?? "").trim(), quote: quoteField(b?.quote) }))
      .filter((b) => b.statement.length > 0);
    concepts.push({
      type: "concept",
      id: headword,
      statement: (c.statement ?? "").trim(),
      quote: quoteField(c.quote),
      ...(bullets.length ? { bullets } : {}),
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

// ---- grade each block drop / distill / retain ----
// The payload retain lane (blueprint §1.1): the ONE deterministic selection that survives the
// settle-chain collapse. Reads a thesis + a concept list ({term,def}), fed from the pre-graph's
// concepts (id→term, statement→def) — its one live caller, compressToGraph in pipeline.ts.
function gradeBlocksPrompt(
  thesis: string,
  concepts: { term: string; def: string }[],
  blocks: Block[],
): string {
  const gloss = glossList(concepts);
  return `You are grading each block of a note for an abstractive compression. You have the note's thesis and its glossary of concepts. Grade EVERY block:
- "drop": off-thesis, OR its content is already captured by a glossary entry (a restatement).
- "distill": on-thesis prose whose ideas should be re-expressed densely — it folds into the glossary and a short prose tie-together. This is the DEFAULT for explanatory text.
- "retain": ONLY content that is already compact and would be destroyed by rewording — a fenced code block, a command line, a file path, a flag, literal output, a list made mostly of [[wikilink]] references (a "related"/"see also" list), or a short line quoted as someone's exact words (reported speech, a quip, a remark attributed to a person — its wording IS the content, so rewording destroys it). Narrative or explanatory PROSE is NEVER "retain", even when it is important, names an example, or contains a [[wikilink]] — that prose is "distill". When unsure between distill and retain, choose distill — but a directly-quoted remark is retain, not distill.
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
  entry: { term: string; def: string },
  sourceText: string,
  lang: "en" | "ru",
): string {
  const relRule =
    DEF_RELATIONS === "keep"
      ? `keep every relation the source states; use only claims the source states.`
      : `define the concept itself; state no relations to other terms (the connective prose carries those); use only claims the source states.`;
  return `Write the glossary definition for "${entry.term}" using ONLY the source text below. One dense sentence; ${relRule} ${langRule(lang)} Return ONLY JSON {"def":"..."}.

SOURCE:
${sourceText}`;
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
  // The model call, injected so tests drive the degradation catch (a thrown
  // TransientError / TruncationError / code bug) without a process-global module
  // mock. Production callers omit it and get the real fw transport.
  ask: typeof askJson = askJson,
): Promise<{ thesisRecoverable: boolean; concepts: ConceptVerdict[] }> {
  try {
    const res = await ask<{ thesisRecoverable?: boolean; concepts?: ConceptVerdict[] }>(
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
  // Injected so tests drive the per-batch degradation catch without a global module
  // mock (see fidelityGate); production callers omit it for the real fw transport.
  ask: typeof askJson = askJson,
): Promise<{ verdicts: Map<string, ProseVerdict>; flaked: Set<string> }> {
  const verdicts = new Map<string, ProseVerdict>();
  const flaked = new Set<string>();
  const BATCH = 5;
  const batches: ProseUnit[][] = [];
  for (let i = 0; i < units.length; i += BATCH) batches.push(units.slice(i, i + BATCH));
  await Promise.all(
    batches.map(async (batch) => {
      try {
        const res = await ask<{ units?: ProseVerdict[] }>(
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
