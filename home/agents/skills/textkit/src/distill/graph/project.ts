// project — the seven-section markdown projector for the canonical distillation graph. A
// `DistillationResult` is the source of truth; this renders ONE projection of
// it: YAML frontmatter mirroring mdstruct Source, a `# title`, an unanchored `## Abstract`,
// then the type-as-section blocks (`## Concepts` / `## Judgements` / `## Inferences` /
// `## Procedures` / `## Payload`) and finally `## Relations`. A section appears only when a
// unit/edge of that type exists — an empty section is never emitted (absence is diagnostic).
//
// This is the pipeline's only projector: main()'s default/--glossary/--reference compress
// paths and the routed build (distillRouted) all render through projectMarkdown; the legacy
// two-channel assemble step it replaced is gone. Pure formatting; no I/O, no model calls.
import {
  ABSTRACT_HEADING,
  formatModalityTag,
  formatSpan,
  MARKED_MODALITIES,
  REL_ARROW,
  REL_DASH,
  RELATIONS_HEADING,
  SECTION_HEADING,
  type DistillationResult,
  type Edge,
  type Unit,
} from "@/distill/graph/graph.ts";

// The projection format version emitted in `schema:`. Distinct from mdstruct's document
// schemaVersion — this versions the markdown PROJECTION shape, not the parser.
const PROJECTION_SCHEMA = "1.0";

// The canonical graph does not (yet) carry the title or the synthesized abstract as
// first-class fields — the abstract is the one unanchored, non-unit block and the title is
// authored orientation. They ride alongside the graph here so the projector can render them
// without widening the canonical `DistillationResult` in graph.ts. A plain `DistillationResult`
// structurally satisfies `Projection` since its extra fields are optional, so callers may pass
// either one with no downcast at the call site.
export interface Projection extends DistillationResult {
  title?: string;
  abstract?: string;
}

// Lowercase only the first character. Unit ids are display headwords ("Boolean flag"); a
// relation endpoint renders the headword lower-initial ("boolean flag") while the section
// heading keeps it verbatim. First-char-only preserves internal capitals (acronyms, names).
function firstLower(s: string): string {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

// Fallback title when none is supplied: the source path's basename, extension stripped,
// separators spaced, first char upper. Cannot recover authored punctuation (commas,
// apostrophes) from a slug, so an explicit `title` is preferred.
function titleFromPath(path: string): string {
  const base = path.replace(/^.*\//, "").replace(/\.[^.]+$/, "");
  const words = base.replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : path;
}

// Split a (possibly multi-line) statement into its non-blank content lines.
function lines(statement: string): string[] {
  return statement
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

// The leading `(modality)` tag on a judgment bullet — rendered only for the two admission-gating
// modalities (`MARKED_MODALITIES` in graph.ts); `assertoric` (or an unmarked judgment) emits no tag.
function modalityTag(unit: Unit): string {
  const m = unit.modality;
  return m && (MARKED_MODALITIES as readonly string[]).includes(m) ? formatModalityTag(m) : "";
}

// The trailing anchor for a TAIL line (concept bullet / procedure step past the lead), read from
// `unit.subSpans` aligned so tail index `i` (0-based over lines after the head) uses
// `subSpans[i]`. Returns the ` start..end` suffix (leading space) when a span exists, else "" — a
// null hole or an absent `subSpans` renders the line unanchored: a line the model synthesized
// without a locatable source quote carries no anchor at all, rather than falling back to the
// head span.
function tailAnchor(unit: Unit, tailIndex: number): string {
  const s = unit.subSpans?.[tailIndex];
  return s ? ` ${formatSpan(s)}` : "";
}

// A concept subsection: `### headword`, a definition line, and per-bullet anchored extension(s).
// The statement's first line is the definition (= intension), anchored by the unit's head `span`;
// each subsequent line is an extension bullet anchored by its OWN `subSpans` entry — a bullet
// with no located quote renders unanchored.
function renderConcept(unit: Unit): string {
  const [def, ...bullets] = lines(unit.statement);
  const parts = [`### ${unit.id}`, `${def} ${formatSpan(unit.span)}`];
  if (bullets.length) {
    parts.push(bullets.map((b, i) => `- ${b}${tailAnchor(unit, i)}`).join("\n"));
  }
  return parts.join("\n\n");
}

// A procedure subsection: `### headword` + numbered steps. The lead step bears the unit's head
// `span`; each later step bears its OWN `subSpans` entry — a step with no located quote renders
// unanchored.
function renderProcedure(unit: Unit): string {
  const steps = lines(unit.statement).map((step, i) =>
    i === 0
      ? `${i + 1}. ${step} ${formatSpan(unit.span)}`
      : `${i + 1}. ${step}${tailAnchor(unit, i - 1)}`,
  );
  return [`### ${unit.id}`, steps.join("\n")].join("\n\n");
}

// A payload subsection: `### key` + the verbatim slice as a blockquote (single line) or a
// fenced block (multi-line), anchored. Payload `statement` IS the verbatim source slice.
function renderPayload(unit: Unit): string {
  const anchor = formatSpan(unit.span);
  if (unit.statement.includes("\n")) {
    return [`### ${unit.id}`, "```\n" + unit.statement + "\n```", anchor].join("\n\n");
  }
  return [`### ${unit.id}`, `> ${unit.statement} ${anchor}`].join("\n\n");
}

// A relation line: `from — predicate → to  <anchor>` (em-dash, right-arrow, TWO spaces before
// the anchor). `from`/`to` reference unit ids; the endpoint label is the referenced unit's
// headword, lower-initial. `rel` is an OPEN token: REL_REGISTRY (text.ts) is a known
// vocabulary, not a closed enum — an off-registry rel (e.g. a deontic or causal predicate) still
// renders. Only a blank rel is rejected; a real one always has a source (normalizeRelation drops
// an empty rel upstream), so this is a defensive floor, not a registry check.
function renderRelation(edge: Edge, unitById: Map<string, Unit>): string {
  if (!edge.rel.trim()) {
    throw new Error(`projectMarkdown: edge.rel is empty`);
  }
  const from = unitById.get(edge.from);
  const to = unitById.get(edge.to);
  if (!from)
    throw new Error(`projectMarkdown: edge.from ${JSON.stringify(edge.from)} references no unit`);
  if (!to)
    throw new Error(`projectMarkdown: edge.to ${JSON.stringify(edge.to)} references no unit`);
  return `- ${firstLower(from.id)}${REL_DASH}${edge.rel}${REL_ARROW}${firstLower(to.id)}  ${formatSpan(edge.span)}`;
}

// Render a type section (`## Heading`) from its units via a per-unit renderer, or "" when the
// type has no units (the section is then omitted — never emit an empty section). `join` is the
// separator BETWEEN rendered units: multi-line subsections (concepts/procedures/payload) take a
// blank-line `"\n\n"` join, while the flat one-bullet-per-unit sections (judgements/inferences)
// take a tight `"\n"` join matching `## Relations` — the bullets are a list, not stanzas.
function typeSection(
  heading: string,
  units: Unit[],
  render: (u: Unit) => string,
  join = "\n\n",
): string {
  if (!units.length) return "";
  return [`## ${heading}`, units.map(render).join(join)].join("\n\n");
}

// Project the canonical graph to its seven-section markdown form. Sections emit in
// fixed order and only when populated; the `## Abstract` is the sole unanchored block.
// `opts.relations` defaults `true`; passing `false` suppresses the `## Relations` section so a
// `type:reference` note stays link-free — the one projector-signature knob the `--reference`
// output path needs.
export function projectMarkdown(result: Projection, opts?: { relations?: boolean }): string {
  const { source, units, edges, title, abstract } = result;
  const relations = opts?.relations ?? true;

  const unitById = new Map(units.map((u) => [u.id, u]));
  const byType = (t: Unit["type"]) => units.filter((u) => u.type === t);

  const blocks: string[] = [];

  blocks.push(
    [
      "---",
      "type: distillation",
      `source: { path: ${source.path}, bytes: ${source.bytes}, sha256: ${source.sha256} }`,
      `schema: ${PROJECTION_SCHEMA}`,
      "---",
    ].join("\n"),
  );

  blocks.push(`# ${title ?? titleFromPath(source.path)}`);

  if (abstract && abstract.trim()) blocks.push(`## ${ABSTRACT_HEADING}\n\n${abstract.trim()}`);

  const sections = [
    typeSection(SECTION_HEADING.concept, byType("concept"), renderConcept),
    typeSection(
      SECTION_HEADING.judgment,
      byType("judgment"),
      (u) => `- ${modalityTag(u)}${u.statement} ${formatSpan(u.span)}`,
      "\n",
    ),
    typeSection(
      SECTION_HEADING.inference,
      byType("inference"),
      (u) => `- ${u.statement} ${formatSpan(u.span)}`,
      "\n",
    ),
    typeSection(SECTION_HEADING.procedure, byType("procedure"), renderProcedure),
    typeSection(SECTION_HEADING.payload, byType("payload"), renderPayload),
    relations && edges.length
      ? [`## ${RELATIONS_HEADING}`, edges.map((e) => renderRelation(e, unitById)).join("\n")].join(
          "\n\n",
        )
      : "",
  ];

  for (const s of sections) if (s) blocks.push(s);

  return blocks.join("\n\n") + "\n";
}
