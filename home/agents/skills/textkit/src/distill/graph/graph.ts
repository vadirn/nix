// graph.ts — the canonical distillation graph, distill's source of truth. A `DistillationResult`
// is a typed, span-anchored knowledge graph `{ source, units[], edges[] }` over the five
// knowledge-element types (concept / judgment / inference / procedure / payload); markdown is one
// projection of that graph, not the graph itself — project.ts renders it and parse-projection.ts
// reads it back. This is a LEAF module: it imports only the `Span` byte-offset type from
// mdstruct.ts so the type contract stays free of the CLI-wrapper's runtime dependencies. The
// cards-harvest path reads emitted notes through this graph's own projection now
// (parse-projection.ts's `## Concepts` reader + text.ts's `## Relations` parser); the pre-canonical
// `GlossEntry`/`Relation` two-channel shape it replaced is gone, so consumers read a note's
// term/def straight off the projection rather than through a second channel.
import { createHash } from "node:crypto";
import type { Span } from "@/distill/mdstruct.ts";

// The five knowledge-element types a distillation unit can take. A unit's `type` is carried by
// WHICH SECTION it renders under in the markdown projection, never by a `type::` field. A payload
// unit's `statement` IS a verbatim source slice; every other type's `statement` is the normalized
// standard-form re-expression of the source it names.
export type UnitType = "concept" | "judgment" | "inference" | "procedure" | "payload";

// The marked-modality vocabulary: the two tags a judgment can carry beyond the unmarked default.
// Canonicalized in one place so the emit tag (project.ts), the strip-regex (parse-projection.ts),
// and the extract-parse clamp (prompts.ts) can't drift on the token spelling or drop one silently.
export const MARKED_MODALITIES = ["hypothesis", "necessarily"] as const;

// A judgment's epistemic modality, which doubles as an admission gate on downstream card
// extraction. Applies to judgments only; an unmarked judgment is `assertoric`. `hypothesis` =
// problematic (not minted as an asserted card), `necessarily` = apodictic. `extractGraphPrompt`
// populates this from the note's own framing (tentative → hypothesis, necessity/must/law →
// necessarily); `parseExtractGraph` clamps anything the model returns outside those two marked
// forms back to `assertoric`.
export type Modality = (typeof MARKED_MODALITIES)[number] | "assertoric";

// Mirrors mdstruct's Rust `Source` (model.rs:74) — the version-binding record. `bytes` and
// `sha256` are computed over the UTF-8 bytes of the source (see computeSource); `source.sha256`
// records which version a graph's spans index into, so a later divergence of the source fails
// loudly instead of resolving spans against shifted bytes.
export interface Source {
  path: string;
  bytes: number;
  sha256: string;
}

// One knowledge element. `span` is a half-open UTF-8 byte range into the source bytes (the
// anchor); `modality` is present on judgments only (optional, unmarked = assertoric).
//
// `subSpans` is an ADDITIVE per-sub-element widening: the single `span` anchors the HEAD line — a
// concept's definition, a procedure's lead step, or the whole flat/payload unit — while `subSpans`
// carries one anchor per TAIL line of a multi-line `statement`, aligned so `subSpans[i]` anchors
// `lines(statement)[i + 1]` (concept extension-bullet `i`, procedure step `i + 1`). A `null` hole
// marks a tail line the projector renders WITHOUT an anchor — a synthesized step or bullet the
// model gave no source quote for. Absent (`undefined`) means a single-span unit: every tail line
// falls back to the projector's legacy behavior. Chosen over restructuring `statement` into a
// `{ text, span }[]` list because it is backward-compatible and leaves the single-span path alone.
export interface Unit {
  id: string;
  type: UnitType;
  statement: string;
  span: Span;
  subSpans?: (Span | null)[];
  modality?: Modality;
}

// One structural edge between two units. `rel` is an open hyphenated token: the known/suggested
// vocabulary lives in REL_REGISTRY (text.ts, the source of truth, not re-declared here), but it is
// a suggestion, not an enforced closed set — an off-registry `rel` is kept and still renders (being
// off-registry is a review flag, never an error). `span` anchors the edge to the source bytes the
// relation was distilled from.
export interface Edge {
  from: string;
  to: string;
  rel: string;
  span: Span;
}

// The canonical distillation graph — the intermediate representation that is distill's source of
// truth, holding the version-binding `source`, the typed `units`, and the structural `edges`.
// Markdown is a projection of this graph, never the reverse.
export interface DistillationResult {
  source: Source;
  units: Unit[];
  edges: Edge[];
}

// ---- the pre-graph: extract's output BEFORE the locate stage ----
// The model emits typed units carrying their verbatim `quote` but NO `span` — tooling computes
// spans at the locate stage, never the model (that is the anti-hallucination primitive). A
// `PreGraph` is what `parseExtractGraph` returns and what `locateGraph` consumes to produce the
// span-anchored `DistillationResult`. `statement` is already the FINAL normalized re-expression
// (concept def / judgement / inference / joined procedure steps), not a draft a later stage
// rewrites. These types sit here so both the parse (prompts.ts) and locate (locate-graph.ts) stages
// read one leaf; they use only the local `UnitType`/`Modality`, so keeping them here leaves graph.ts
// a leaf.

// One pre-locate unit: a typed re-expression plus the verbatim `quote` the locate stage resolves
// to a byte span.
export interface PreUnit {
  type: UnitType;
  // present for concepts (the headword id); judgement/inference ids are ordinal, assigned at
  // locate (J1../I1..); a procedure's headword rides on its group, not the step PreUnit.
  id?: string;
  statement: string;
  quote: string;
  modality?: Modality;
  // A concept's extension bullets — the division-list or predicated-property lines the note states
  // ABOUT the concept beyond its definition. Each carries its OWN verbatim `quote` so locate anchors
  // each bullet independently (its own `subSpan` on the located `Unit`), rather than reusing the
  // definition's span. Populated by `parseExtractGraph` from the extract prompt's per-concept
  // `bullets` array; absent when the note enumerates none.
  bullets?: { statement: string; quote: string }[];
}

// One pre-locate edge. `fromHeadword` is the owning concept's headword (its unit id at locate);
// there is deliberately no `predicate` field — the projection never renders one, so extract does
// not carry it. `quote` is the verbatim source slice the relation was distilled from (the
// span-locate anchor).
export interface PreEdge {
  fromHeadword: string;
  rel: string;
  to: string;
  quote: string;
}

// The whole pre-locate extract: document-level orientation (title/abstract/description/thesis)
// plus the four re-expressed type channels and the flat edge list. Payload is NOT a channel — it
// is a deterministic post-extract lane computed by retain-grading the source's verbatim blocks,
// folded in at locate.
export interface PreGraph {
  title: string;
  abstract: string;
  description: string;
  thesis: string;
  concepts: PreUnit[];
  judgements: PreUnit[];
  inferences: PreUnit[];
  procedures: { headword: string; steps: PreUnit[] }[];
  edges: PreEdge[];
}

// Render a span as the bare trailing-anchor notation `start..end` — the half-open byte range
// distill appends at the end of a projected line. The bracketed `[start..end]` form is an accepted
// INPUT (parseSpan reads both); emit is always bare to match the projection.
export function formatSpan(span: Span): string {
  return `${span[0]}..${span[1]}`;
}

// Parse the `start..end` anchor notation into a Span. Accepts both the bare `start..end` and the
// bracketed `[start..end]` forms — both denote the same half-open byte range. Brackets must be
// balanced; anything else throws (a hard parse failure, never a sentinel).
export function parseSpan(str: string): Span {
  const m = str.trim().match(/^(?:\[(\d+)\.\.(\d+)\]|(\d+)\.\.(\d+))$/);
  if (!m) {
    throw new Error(
      `parseSpan: not a byte-span anchor: ${JSON.stringify(str)} (expected "start..end" or "[start..end]")`,
    );
  }
  const start = Number(m[1] ?? m[3]);
  const end = Number(m[2] ?? m[4]);
  return [start, end];
}

// The trailing byte-anchor grammar, canonicalized in one place: matches a `start..end` or
// `[start..end]` anchor sitting at the end of a rendered line, preceded by whitespace separating it
// from the line's text. Group 1 is the anchor's own substring (brackets included when present) —
// callers that must preserve the ON-DISK form verbatim (apply-mode's def-line splice re-appends the
// anchor unchanged rather than reformatting it) read the group directly instead of going through
// stripTrailingAnchor. The projector (formatSpan) only ever emits the bare form; the bracketed form
// appears only in hand-edited notes.
export const TRAILING_ANCHOR_RE = /\s+(\[\d+\.\.\d+\]|\d+\.\.\d+)\s*$/;

// Strip a trailing byte-anchor off a rendered line, in EITHER grammar form. Returns the bare text
// with the anchor (and its separating whitespace) removed, and the parsed Span — null when the
// line carries no trailing anchor (a hand edit may have dropped it). Routes the actual parse
// through parseSpan so the two accepted forms stay defined in exactly one place.
export function stripTrailingAnchor(line: string): { text: string; span: Span | null } {
  const m = line.match(TRAILING_ANCHOR_RE);
  if (!m) return { text: line.trim(), span: null };
  return { text: line.slice(0, m.index).trim(), span: parseSpan(m[1]!) };
}

// The `## Relations` wire separators: a space-flanked em-dash before the predicate and a
// space-flanked right-arrow before the target, rendering `<from> — <rel> → <to>`. project.ts's
// renderRelation emits both; text.ts's parseArrowEdge locates them via indexOf to split the
// line. Canonicalized here so the two sides cannot drift on the glyph or the flanking spaces.
export const REL_DASH = " — ";
export const REL_ARROW = " → ";

// The `## Heading` vocabulary: one heading per UnitType, plus the two non-unit sections (Abstract,
// Relations) the projection also carries. project.ts's typeSection renders these headings directly;
// parse-projection.ts's section lookup derives its lowercase match keys from the same strings (via
// `.toLowerCase()`) so a renamed heading can't silently orphan the reader's key.
export const SECTION_HEADING: Record<UnitType, string> = {
  concept: "Concepts",
  judgment: "Judgements",
  inference: "Inferences",
  procedure: "Procedures",
  payload: "Payload",
};
export const ABSTRACT_HEADING = "Abstract";
export const RELATIONS_HEADING = "Relations";

// The one canonical content stamp: the first 12 hex digits (48 bits) of the sha256 over `bytes`.
// Every provenance and verify site routes through here — computeSource's frontmatter
// `source.sha256` (bare) and apply-mode's `sha256:`-prefixed emit/preflight stamp — so the
// truncation width is defined ONCE. Widening it for collision-safety at one site while missing
// another would make apply's `src=` verification silently mis-verify.
export function stampSha(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 12);
}

// Compute a `Source` in TS over the UTF-8 bytes of `text`: `bytes` is the UTF-8 byte length and
// `sha256` is the 12-hex stamp (stampSha) of those same bytes, so the projection's `source.sha256`
// (project.ts renders it verbatim) is the same prefix apply-mode re-stamps and compares. Kept in TS
// rather than delegating to mdstruct so graph.ts stays a leaf — it does NOT extend MdDoc or shell
// the Rust binary.
export function computeSource(path: string, text: string): Source {
  const utf8 = Buffer.from(text, "utf8");
  return {
    path,
    bytes: utf8.length,
    sha256: stampSha(utf8),
  };
}
