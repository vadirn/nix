// parse-projection — the READER inverse of project.ts's seven-section projector. A canonical
// distillation note (spec §3) is `# title` + `## Abstract` + the type-as-section blocks
// (`## Concepts` / `## Judgements` / `## Inferences` / `## Procedures` / `## Payload`) +
// `## Relations`; this parses that markdown back into structured sections so the interactive
// consumers (apply-mode's body edits, prose-mode's re-prose) can locate and edit `### headword`
// concept blocks, numbered `## Procedures` steps, and the abstract WITHOUT re-parsing the grammar
// four times. It reuses parseSpan (graph.ts) for the trailing `start..end` anchors.
//
// The cards-harvest path (cards/cards.ts::harvestConcepts) reads its concepts THROUGH this
// reader now (D6): `parseCanonicalNote(body).concepts` for term/def, paired with text.ts's
// surviving `## Relations` parser for edges. The legacy `## Glossary` table reader
// (parseConceptGraph) and its GlossEntry/Relation types are gone.
//
// PURE: no fs, no LLM, no model of the source bytes — it reads only the projected markdown.
import { parseSpan, stripTrailingAnchor } from "./graph.ts";
import { fenceScan, type FenceState } from "./text.ts";
import type { Span } from "./mdstruct.ts";

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
// recovering the per-sub-element spans the projector now emits (design Backlog 12).
export interface CanonConcept {
  headword: string;
  def: string;
  bullets: string[];
  bulletSpans: (Span | null)[];
  span: Span | null;
}

// A procedure subsection: `### headword` + numbered steps, each stripped of a trailing anchor.
// `span` is the lead step's anchor; `stepSpans` is parallel to `steps` — each step's OWN anchor
// (null when hand-edited away or a synthesized step), so `stepSpans[0]` equals `span`. Recovers the
// per-step anchors the projector now emits (design Backlog 12).
export interface CanonProcedure {
  headword: string;
  steps: string[];
  stepSpans: (Span | null)[];
  span: Span | null;
}

// A flat one-bullet-per-unit item (judgement / inference): statement stripped of anchor.
export interface CanonFlat {
  statement: string;
  span: Span | null;
}

// A payload subsection: `### key` + the verbatim slice (blockquote or fenced), anchor.
export interface CanonPayload {
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
// A line that is ONLY a byte-span anchor (the multi-line Payload fence's bare anchor line —
// see the fenced-payload branch below). W2: NOT derived from graph.ts's TRAILING_ANCHOR_RE —
// that pattern requires a LEADING `\s+` before the anchor (it strips an anchor off the tail of
// a text-bearing line), whereas this one whole-line-anchors (`^...$`) a line with no leading
// text at all. Forcing a shared source for two different anchoring positions (trailing-after-
// whitespace vs. whole-line) would need the anchor body factored into its own regex-source
// string for both files to splice — more indirection than the one-line duplication it removes.
const ANCHOR_ONLY_RE = /^(?:\[\d+\.\.\d+\]|\d+\.\.\d+)$/;

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
// (null when the line carries no anchor — a hand-edited note may have dropped it). BUG-3: this
// used to hand-spell a BARE-ONLY regex (`/^(.*?)\s+(\d+\.\.\d+)\s*$/`), so a hand-edited line
// ending in the bracketed form (`... [128..192]`) fell through the no-match branch — the brackets
// leaked into `text` and `span` came back null. Delegates to graph.ts's stripTrailingAnchor (W2),
// which accepts both forms, closing that gap.
export function stripAnchor(line: string): { text: string; span: Span | null } {
  return stripTrailingAnchor(line);
}

// Group a section's body lines into `### headword` subsections: the lines under each `### ` up to
// the next `### ` (or the section end). Lines before the first `### ` are ignored (a well-formed
// projection has none). Fence-aware, mirroring splitSections: a `### `-look-alike line inside a
// ``` code block (e.g. a comment in a fenced Payload snippet) is literal content, not a subsection
// boundary — without this, a fenced Payload containing a "### " comment line split into garbage
// entries (the fence content lost its close, the fake header's line became a bogus second entry).
function subsections(bodyLines: string[]): { headword: string; lines: string[] }[] {
  const out: { headword: string; lines: string[] }[] = [];
  let cur: { headword: string; lines: string[] } | null = null;
  let fence: FenceState = null;
  for (const line of bodyLines) {
    const scan = fenceScan(line, fence);
    fence = scan.fence;
    if (scan.isMarker) {
      if (cur) cur.lines.push(line);
      continue;
    }
    if (fence) {
      if (cur) cur.lines.push(line);
      continue;
    }
    const h = SUB_RE.exec(line);
    if (h) {
      cur = { headword: h[1]!, lines: [] };
      out.push(cur);
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  return out;
}

// The leading `(modality) ` tag the projector prepends to a hypothesis/necessarily judgement.
const MODALITY_TAG_RE = /^\((?:hypothesis|necessarily)\)\s+/;

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

  const abstract = (by("abstract")?.bodyLines ?? []).join("\n").trim();

  // Hardening: a `### headword` with no definition line (back-to-back headers, or a
  // bullets-only subsection) is malformed — a hand edit dropped or split the entry. Skip it
  // rather than surface an empty-def concept, symmetric with prose-mode.ts::parseDistilled's
  // `.filter((c) => c.headword && c.def)` (pure.test.ts:653-664).
  const concepts: CanonConcept[] = subsections(by("concepts")?.bodyLines ?? [])
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
  const procedures: CanonProcedure[] = subsections(by("procedures")?.bodyLines ?? [])
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

  const payload: CanonPayload[] = subsections(by("payload")?.bodyLines ?? []).map((sub) => {
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

  const relations = (by("relations")?.bodyLines ?? [])
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim());

  return {
    abstract,
    concepts,
    judgements: flat("judgements"),
    inferences: flat("inferences"),
    procedures,
    payload,
    relations,
  };
}
