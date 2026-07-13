// project — the seven-section markdown projector for the canonical distillation graph
// (spec §3). A `DistillationResult` is the source of truth; this renders ONE projection of
// it: YAML frontmatter mirroring mdstruct Source, a `# title`, an unanchored `## Abstract`,
// then the type-as-section blocks (`## Concepts` / `## Judgements` / `## Inferences` /
// `## Procedures` / `## Payload`) and finally `## Relations`. A section appears only when a
// unit/edge of that type exists — an empty section is never emitted (absence is diagnostic).
//
// This is the pipeline's only projector: main()'s default/--glossary/--reference compress
// paths and the routed build (distillRouted) all render through projectMarkdown; the legacy
// two-channel assemble step it replaced is gone. Pure formatting; no I/O, no model calls.
import { formatSpan, type DistillationResult, type Edge, type Unit } from "./graph.ts";

// The projection format version emitted in `schema:`. Distinct from mdstruct's document
// schemaVersion — this versions the markdown PROJECTION shape, not the parser.
const PROJECTION_SCHEMA = "1.0";

// The canonical graph does not (yet) carry the title or the synthesized abstract as
// first-class fields — the abstract is the one unanchored, non-unit block and the title is
// authored orientation. They ride alongside the graph here so the projector can render them
// without widening the canonical `DistillationResult` in graph.ts (the extract prompt will
// populate them; design Backlog). A `Projection` is structurally a `DistillationResult`, so
// callers may pass either: a plain `DistillationResult` structurally satisfies `Projection` (the
// extra fields are optional), so the param types as `Projection` with no downcast at the call.
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

// The leading `(modality)` tag on a judgment bullet — ONLY for the two admission-gating
// modalities. `assertoric` (or unmarked) emits no tag (spec §3).
function modalityTag(unit: Unit): string {
  if (unit.modality === "hypothesis") return "(hypothesis) ";
  if (unit.modality === "necessarily") return "(necessarily) ";
  return "";
}

// The trailing anchor for a TAIL line (concept bullet / procedure step past the lead), read from
// `unit.subSpans` aligned so tail index `i` (0-based over lines after the head) uses
// `subSpans[i]`. Returns the ` start..end` suffix (leading space) when a span exists, else "" — a
// null hole or an absent `subSpans` renders the line unanchored (spec §3's synthesized step-2).
function tailAnchor(unit: Unit, tailIndex: number): string {
  const s = unit.subSpans?.[tailIndex];
  return s ? ` ${formatSpan(s)}` : "";
}

// A concept subsection: `### headword`, a definition line, and per-bullet anchored extension(s).
// The statement's first line is the definition (= intension), anchored by the unit's head `span`;
// each subsequent line is an extension bullet anchored by its OWN `subSpans` entry (per-sub-element
// anchoring, design Backlog 12) — a bullet with no located quote renders unanchored.
function renderConcept(unit: Unit): string {
  const [def, ...bullets] = lines(unit.statement);
  const parts = [`### ${unit.id}`, `${def} ${formatSpan(unit.span)}`];
  if (bullets.length) {
    parts.push(bullets.map((b, i) => `- ${b}${tailAnchor(unit, i)}`).join("\n"));
  }
  return parts.join("\n\n");
}

// A procedure subsection: `### headword` + numbered steps. The lead step bears the unit's head
// `span`; each later step bears its OWN `subSpans` entry (per-step anchoring, design Backlog 12) —
// a step with no located quote renders unanchored (spec §3's step-2 example).
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
// headword, lower-initial. `rel` is an OPEN token (spec §3): REL_REGISTRY (text.ts) is a known
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
  return `- ${firstLower(from.id)} — ${edge.rel} → ${firstLower(to.id)}  ${formatSpan(edge.span)}`;
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

// Project the canonical graph to its seven-section markdown form (spec §3). Sections emit in
// fixed order and only when populated; the `## Abstract` is the sole unanchored block.
// `opts.relations` defaults `true`; passing `false` suppresses the `## Relations` section so a
// `type:reference` note stays link-free (D30) — the one projector-signature knob the `--reference`
// output path needs (blueprint §6/§6.2).
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

  if (abstract && abstract.trim()) blocks.push(`## Abstract\n\n${abstract.trim()}`);

  const sections = [
    typeSection("Concepts", byType("concept"), renderConcept),
    typeSection(
      "Judgements",
      byType("judgment"),
      (u) => `- ${modalityTag(u)}${u.statement} ${formatSpan(u.span)}`,
      "\n",
    ),
    typeSection(
      "Inferences",
      byType("inference"),
      (u) => `- ${u.statement} ${formatSpan(u.span)}`,
      "\n",
    ),
    typeSection("Procedures", byType("procedure"), renderProcedure),
    typeSection("Payload", byType("payload"), renderPayload),
    relations && edges.length
      ? [`## Relations`, edges.map((e) => renderRelation(e, unitById)).join("\n")].join("\n\n")
      : "",
  ];

  for (const s of sections) if (s) blocks.push(s);

  return blocks.join("\n\n") + "\n";
}
