// parse-projection — the READER inverse of project.ts's seven-section projector. A canonical
// distillation note (spec §3) is `# title` + `## Abstract` + the type-as-section blocks
// (`## Concepts` / `## Judgements` / `## Inferences` / `## Procedures` / `## Payload`) +
// `## Relations`; this parses that markdown back into structured sections so the interactive
// consumers (apply-mode's body edits, prose-mode's re-prose) can locate and edit `### headword`
// concept blocks, numbered `## Procedures` steps, and the abstract WITHOUT re-parsing the grammar
// four times. It reuses parseSpan (graph.ts) for the trailing `start..end` anchors.
//
// This is DISTINCT from text.ts::parseConceptGraph, which reads the LEGACY `## Glossary` TABLE +
// `## Relations` into GlossEntry[] for the cards-harvest path (that reader, and GlossEntry/Relation,
// stay untouched — they serve cards/, out of scope here). The grammar here is the canonical
// `### headword` subsection shape, not table rows.
//
// PURE: no fs, no LLM, no model of the source bytes — it reads only the projected markdown.
import { parseSpan } from "./graph.ts";
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
// stripped of its trailing anchor. `span` is the def line's anchor (null when hand-edited away).
export interface CanonConcept {
  headword: string;
  def: string;
  bullets: string[];
  span: Span | null;
}

// A procedure subsection: `### headword` + numbered steps, each stripped of a trailing anchor.
// `span` is the lead step's anchor (only the lead step is anchored by the projector).
export interface CanonProcedure {
  headword: string;
  steps: string[];
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

export interface CanonNote {
  abstract: string;
  concepts: CanonConcept[];
  judgements: CanonFlat[];
  inferences: CanonFlat[];
  procedures: CanonProcedure[];
  payload: CanonPayload[];
  relations: string[]; // raw list-item bodies (after the `- ` marker), verbatim
}

const FENCE_RE = /^(```|~~~)/;
const SECTION_RE = /^##\s+(\S.*?)\s*$/; // `## Heading` — two hashes exactly (excludes `### `)
const SUB_RE = /^###\s+(\S.*?)\s*$/; // `### headword` subsection
const ANCHOR_ONLY_RE = /^(?:\[\d+\.\.\d+\]|\d+\.\.\d+)$/; // a line that is ONLY a byte-span anchor

// Split a note body into its `## ` sections. Content before the first `## ` (the `# title` and any
// head prose) is not a section and is dropped from the result — callers that need it read the raw
// lines themselves. Fence-tracked so a `## ` line inside a Payload fence is literal content.
export function splitSections(body: string): CanonSection[] {
  const lines = body.split("\n");
  const heads: { name: string; heading: string; start: number }[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const fm = FENCE_RE.exec(lines[i]!.trimStart());
    if (fm) {
      const marker = fm[1]![0]!;
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
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

// Strip a trailing ` start..end` byte-anchor off a rendered line, returning the bare text and the
// parsed span (null when the line carries no anchor — a hand-edited note may have dropped it).
export function stripAnchor(line: string): { text: string; span: Span | null } {
  const m = line.match(/^(.*?)\s+(\d+\.\.\d+)\s*$/);
  if (!m) return { text: line.trim(), span: null };
  return { text: m[1]!.trim(), span: parseSpan(m[2]!) };
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
  let fence: string | null = null;
  for (const line of bodyLines) {
    const fm = FENCE_RE.exec(line.trimStart());
    if (fm) {
      const marker = fm[1]![0]!;
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
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

// Parse a canonical note body into its structured sections. Absent sections yield empty arrays /
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
      for (const line of content) {
        const t = line.trim();
        if (t.startsWith("- ")) {
          bullets.push(stripAnchor(t.slice(2)).text);
        } else if (!def) {
          const a = stripAnchor(t);
          def = a.text;
          span = a.span;
        }
      }
      return { headword: sub.headword, def, bullets, span };
    })
    .filter((c) => c.headword && c.def);

  // Same hardening for Procedures: a `### headword` with no numbered-step lines is the
  // procedure analogue of an empty def — skip rather than surface a step-less entry.
  const procedures: CanonProcedure[] = subsections(by("procedures")?.bodyLines ?? [])
    .map((sub) => {
      const steps: string[] = [];
      let span: Span | null = null;
      for (const line of sub.lines) {
        const m = line.match(/^\s*\d+\.\s(.*)$/);
        if (!m) continue;
        const a = stripAnchor(m[1]!);
        if (steps.length === 0) span = a.span;
        steps.push(a.text);
      }
      return { headword: sub.headword, steps, span };
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
