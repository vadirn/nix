// parse-projection — the READER inverse of project.ts's seven-section projector. A canonical
// distillation note is `# title` + `## Abstract` + the type-as-section blocks
// (`## Concepts` / `## Judgements` / `## Inferences` / `## Procedures` / `## Payload`) +
// `## Relations`; this parses that markdown back into structured sections so the interactive
// consumers (apply-mode's body edits, prose-mode's re-prose) can locate and edit `### headword`
// concept blocks, numbered `## Procedures` steps, and the abstract WITHOUT re-parsing the grammar
// four times. It reuses parseSpan (graph.ts) for the trailing `start..end` anchors.
//
// The cards-harvest path (cards/cards.ts::harvestConcepts) reads its concepts THROUGH this
// reader now: `parseCanonicalNote(body).concepts` for term/def, paired with text.ts's
// surviving `## Relations` parser for edges. The legacy `## Glossary` table reader
// (parseConceptGraph) and its GlossEntry/Relation types are gone.
//
// PURE: no fs, no LLM, no model of the source bytes — it reads only the projected markdown.
import {
  ABSTRACT_HEADING,
  ANCHOR_BODY,
  MODALITY_TAG_RE,
  parseSpan,
  RELATIONS_HEADING,
  SECTION_HEADING,
  stripTrailingAnchor,
} from "#src/distill/graph/graph.ts";
import { fenceScan, type FenceState } from "#src/core/text.ts";
import type { Span } from "#src/distill/mdstruct.ts";

// One `## ` section: its heading text (verbatim, e.g. "Concepts"), the body lines between the
// heading and the next `## ` (or EOF), and the half-open line range [start, end). Fence-aware:
// a `## ` inside a ``` code block (a multi-line Payload) does NOT open a new section.
export interface CanonSection {
  name: string; // the heading text, lowercased+trimmed ("abstract", "concepts", …) — the match key
  heading: string; // the heading text verbatim
  bodyLines: string[];
  start: number; // line index of the `## ` heading
  end: number; // exclusive line index (next `## ` heading or EOF)
}

// A concept subsection: `### headword`, a first-line definition, `- bullet` extension lines, each
// stripped of its trailing anchor. `span` is the def line's anchor (null when hand-edited away);
// `bulletSpans` is parallel to `bullets` — each bullet's OWN anchor (null when it carries none),
// recovering the per-sub-element spans the projector now emits.
interface CanonConcept {
  headword: string;
  def: string;
  bullets: string[];
  bulletSpans: (Span | null)[];
  span: Span | null;
}

// A procedure subsection: `### headword` + numbered steps, each stripped of a trailing anchor.
// `span` is the lead step's anchor; `stepSpans` is parallel to `steps` — each step's OWN anchor
// (null when hand-edited away or a synthesized step), so `stepSpans[0]` equals `span`. Recovers the
// per-step anchors the projector now emits.
interface CanonProcedure {
  headword: string;
  steps: string[];
  stepSpans: (Span | null)[];
  span: Span | null;
}

// A flat one-bullet-per-unit item (judgement / inference): statement stripped of anchor.
interface CanonFlat {
  statement: string;
  span: Span | null;
}

// A payload subsection: `### key` + the verbatim slice (blockquote or fenced), anchor.
interface CanonPayload {
  headword: string;
  body: string;
  span: Span | null;
}

// The structured READ view of a canonical note — the sections the interactive consumers
// (apply-mode body edits, prose-mode re-prose, cards harvest) locate and edit. It is LOSSY and
// is NOT the inverse of a `DistillationResult` (graph.ts): `relations` stay raw list-item
// strings, not typed `Edge`s (run text.ts::parseRelationsBlock over them when you need
// from/rel/to structure); the `source:` provenance, every unit's source `quote`, and each
// unit's `type` beyond the section it landed in are all absent; and malformed content is dropped
// silently (see parseCanonicalNote's header note). So a CanonNote can never re-project or
// re-distill — do not build a round-trip path on it; reparse the source note instead.
export interface CanonNote {
  abstract: string;
  concepts: CanonConcept[];
  judgements: CanonFlat[];
  inferences: CanonFlat[];
  procedures: CanonProcedure[];
  payload: CanonPayload[];
  relations: string[]; // raw list-item bodies (after the `- ` marker), verbatim — not typed edges
}

const FENCE_RE = /^(```|~~~)/;
const SECTION_RE = /^##\s+(\S.*?)\s*$/; // `## Heading` — two hashes exactly (excludes `### `)
const SUB_RE = /^###\s+(\S.*?)\s*$/; // `### headword` subsection
// A line that is ONLY a byte-span anchor (the multi-line Payload fence's bare anchor line — see the
// fenced-payload branch below). Whole-line-anchors (`^...$`) the shared ANCHOR_BODY grammar, a
// distinct framing from graph.ts's TRAILING_ANCHOR_RE (which requires a LEADING `\s+` to strip an
// anchor off the tail of a text-bearing line); both splice the same ANCHOR_BODY source so the
// byte-range spelling stays in one place.
const ANCHOR_ONLY_RE = new RegExp(`^(?:${ANCHOR_BODY})$`);

// Split a note body into its `## ` sections. Content before the first `## ` (the `# title` and any
// head prose) is not a section and is dropped from the result — callers that need it read the raw
// lines themselves. Fence-tracked so a `## ` line inside a Payload fence is literal content.
export function splitSections(body: string): CanonSection[] {
  const lines = body.split("\n");
  const heads: { name: string; heading: string; start: number }[] = [];
  let fence: FenceState = null;
  for (let i = 0; i < lines.length; i++) {
    const scan = fenceScan(lines[i]!, fence);
    fence = scan.fence;
    if (scan.isMarker) continue;
    if (fence) continue;
    const h = SECTION_RE.exec(lines[i]!);
    if (h) heads.push({ name: h[1]!.toLowerCase(), heading: h[1]!, start: i });
  }
  return heads.map((h, k) => {
    const end = k + 1 < heads.length ? heads[k + 1]!.start : lines.length;
    return {
      name: h.name,
      heading: h.heading,
      start: h.start,
      end,
      bodyLines: lines.slice(h.start + 1, end),
    };
  });
}

// Strip a trailing byte-anchor off a rendered line, returning the bare text and the parsed span
// (null when the line carries no anchor — a hand-edited note may have dropped it). Delegates to
// graph.ts's shared stripTrailingAnchor, which accepts both the bare `start..end` and bracketed
// `[start..end]` anchor forms — a hand-rolled bare-only regex here would leave a bracketed
// anchor unparsed AND visible in the text: `text` would keep the literal brackets
// (`"...[128..192]"`) and `span` would come back null instead of parsing.
function stripAnchor(line: string): { text: string; span: Span | null } {
  return stripTrailingAnchor(line);
}

// One `### headword` subsection's line range within the body lines it was scanned from:
// [start, end) where `start` is the `### headword` line and `end` is the next `### ` (or the
// end of those lines). Indices are RELATIVE to the array passed in — a caller holding whole-note
// line numbers adds the section's `start + 1`.
export interface SubsectionRange {
  headword: string;
  start: number;
  end: number; // exclusive
}

// Locate the `### headword` subsections of a section's body lines. THE one subsection walk:
// parse-projection's own readers below and apply-mode's body-editing locators
// (subsectionRange / procedureStepRange / headwordsUnder) both come through here, so the two
// cannot drift on what counts as a heading. Lines before the first `### ` belong to no
// subsection and are unreachable from the result (a well-formed projection has none).
// Fence-aware, mirroring splitSections: a `### `-look-alike line inside a ``` code block (a
// comment in a fenced Payload snippet, a markdown sample quoted under a concept) is literal
// content, not a subsection boundary — without this, a fenced Payload containing a "### "
// comment line split into garbage entries (the fence content lost its close, the fake header's
// line became a bogus second entry), and an editing caller truncated the real subsection's
// range at the fake heading.
export function subsectionRanges(bodyLines: string[]): SubsectionRange[] {
  const heads: { headword: string; start: number }[] = [];
  let fence: FenceState = null;
  for (let i = 0; i < bodyLines.length; i++) {
    const scan = fenceScan(bodyLines[i]!, fence);
    fence = scan.fence;
    if (scan.isMarker) continue;
    if (fence) continue;
    const h = SUB_RE.exec(bodyLines[i]!);
    if (h) heads.push({ headword: h[1]!, start: i });
  }
  return heads.map((h, k) => ({
    headword: h.headword,
    start: h.start,
    end: k + 1 < heads.length ? heads[k + 1]!.start : bodyLines.length,
  }));
}

// Group a section's body lines into `### headword` subsections: the lines under each `### ` up
// to the next `### ` (or the section end), read off subsectionRanges.
function subsections(bodyLines: string[]): { headword: string; lines: string[] }[] {
  return subsectionRanges(bodyLines).map((r) => ({
    headword: r.headword,
    lines: bodyLines.slice(r.start + 1, r.end),
  }));
}

// Parse a canonical note body into its structured sections — the lossy READ view documented on
// CanonNote (edge typing, unit quotes, and source provenance are NOT recovered; this never
// round-trips to a DistillationResult). Absent sections yield empty arrays /
// an empty abstract (the projector omits an empty section, so absence is the normal signal). A
// hand-dropped anchor degrades to `span: null` (text still parses); an empty-def concept or
// step-less procedure is dropped entirely rather than surfaced as a degenerate entry (see the
// concepts/procedures filters below). A malformed `### ` header (no space, wrong hash count,
// leading whitespace) never opens a subsection, so its content is silently lost.
export function parseCanonicalNote(body: string): CanonNote {
  const sections = splitSections(body);
  const by = (name: string) => sections.find((s) => s.name === name);

  const abstract = (by(ABSTRACT_HEADING.toLowerCase())?.bodyLines ?? []).join("\n").trim();

  // Hardening: a `### headword` with no definition line (back-to-back headers, or a
  // bullets-only subsection) is malformed — a hand edit dropped or split the entry. Skip it
  // rather than surface an empty-def concept, symmetric with prose-mode.ts::parseDistilled's
  // `.filter((c) => c.headword && c.def)` (pure.test.ts:653-664).
  const concepts: CanonConcept[] = subsections(
    by(SECTION_HEADING.concept.toLowerCase())?.bodyLines ?? [],
  )
    .map((sub) => {
      const content = sub.lines.filter((l) => l.trim().length > 0);
      let def = "";
      let span: Span | null = null;
      const bullets: string[] = [];
      const bulletSpans: (Span | null)[] = [];
      for (const line of content) {
        const t = line.trim();
        if (t.startsWith("- ")) {
          const a = stripAnchor(t.slice(2));
          bullets.push(a.text);
          bulletSpans.push(a.span);
        } else if (!def) {
          const a = stripAnchor(t);
          def = a.text;
          span = a.span;
        }
      }
      return { headword: sub.headword, def, bullets, bulletSpans, span };
    })
    .filter((c) => c.headword && c.def);

  // Same hardening for Procedures: a `### headword` with no numbered-step lines is the
  // procedure analogue of an empty def — skip rather than surface a step-less entry.
  const procedures: CanonProcedure[] = subsections(
    by(SECTION_HEADING.procedure.toLowerCase())?.bodyLines ?? [],
  )
    .map((sub) => {
      const steps: string[] = [];
      const stepSpans: (Span | null)[] = [];
      let span: Span | null = null;
      for (const line of sub.lines) {
        const m = line.match(/^\s*\d+\.\s(.*)$/);
        if (!m) continue;
        const a = stripAnchor(m[1]!);
        if (steps.length === 0) span = a.span;
        steps.push(a.text);
        stepSpans.push(a.span);
      }
      return { headword: sub.headword, steps, stepSpans, span };
    })
    .filter((p) => p.headword && p.steps.length > 0);

  const flat = (name: string): CanonFlat[] =>
    (by(name)?.bodyLines ?? [])
      .map((l) => l.trim())
      .filter((l) => l.startsWith("- "))
      .map((l) => {
        const a = stripAnchor(l.slice(2).replace(MODALITY_TAG_RE, ""));
        return { statement: a.text, span: a.span };
      });

  const payload: CanonPayload[] = subsections(
    by(SECTION_HEADING.payload.toLowerCase())?.bodyLines ?? [],
  ).map((sub) => {
    // single-line `> quote anchor`, or a fenced block whose closing fence is followed by the anchor
    const lines = sub.lines;
    const quote = lines.find((l) => l.trim().startsWith(">"));
    if (quote) {
      const a = stripAnchor(quote.trim().replace(/^>\s?/, ""));
      return { headword: sub.headword, body: a.text, span: a.span };
    }
    // fenced: collect between the first and next fence; the anchor is the first non-blank line after
    const open = lines.findIndex((l) => FENCE_RE.test(l.trimStart()));
    let span: Span | null = null;
    const inner: string[] = [];
    if (open >= 0) {
      let i = open + 1;
      for (; i < lines.length; i++) {
        if (FENCE_RE.test(lines[i]!.trimStart())) break;
        inner.push(lines[i]!);
      }
      for (let j = i + 1; j < lines.length; j++) {
        const bare = lines[j]!.trim();
        if (bare.length === 0) continue;
        // The projector renders a multi-line payload's anchor as a BARE `start..end` line after
        // the closing fence (renderPayload, project.ts) — no leading text, so stripAnchor (which
        // needs `text<space>anchor`) cannot see it. Parse a bare anchor directly; fall back to
        // stripAnchor for a hand-edited `text anchor` line, and to null when the anchor was dropped.
        span = ANCHOR_ONLY_RE.test(bare) ? parseSpan(bare) : stripAnchor(bare).span;
        break;
      }
    }
    return { headword: sub.headword, body: inner.join("\n"), span };
  });

  const relations = (by(RELATIONS_HEADING.toLowerCase())?.bodyLines ?? [])
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim());

  return {
    abstract,
    concepts,
    judgements: flat(SECTION_HEADING.judgment.toLowerCase()),
    inferences: flat(SECTION_HEADING.inference.toLowerCase()),
    procedures,
    payload,
    relations,
  };
}
