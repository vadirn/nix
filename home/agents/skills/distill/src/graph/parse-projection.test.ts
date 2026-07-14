// parse-projection.test.ts — round-trip tests for parseCanonicalNote (the reader inverse of the
// seven-section projector). Focus: the reader recovers what projectMarkdown emits, including a
// multi-line `## Payload` fence whose anchor renders as a BARE `start..end` line after the closing
// fence (renderPayload). Pure; no mdstruct binary. Run: `bun test parse-projection.test.ts`.
import { expect, test } from "bun:test";
import { projectMarkdown, type Projection } from "@/graph/project.ts";
import { parseCanonicalNote } from "@/graph/parse-projection.ts";

// ---- hardening: hand-built (not round-tripped) malformed/hand-edited bodies ----
// The projector never emits any of the shapes below; these pin the reader's degrade-gracefully
// contract for hand-edited notes (dropped anchors, malformed headers, fence-unaware subsections,
// empty defs). See /tmp/claude-501/parse-projection-recon.md for the gap analysis.

// strip the frontmatter block the projector prepends, leaving the body the reader consumes.
function bodyOf(md: string): string {
  const m = md.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return m ? m[1]! : md;
}

const NOTE: Projection = {
  source: { path: "cfg.md", bytes: 200, sha256: "deadbeef0000" },
  title: "Config example",
  abstract: "A note whose payload is a multi-line fenced code block.",
  units: [
    { id: "timeout", type: "concept", statement: "the per-request deadline in ms", span: [10, 40] },
    {
      id: "must-hold",
      type: "judgment",
      statement: "the deadline must exceed zero",
      modality: "necessarily",
      span: [41, 70],
    },
    // multi-line payload: statement carries a newline, so renderPayload emits a fence + bare anchor
    {
      id: "default config",
      type: "payload",
      statement: "timeout: 5000\nretries: 3",
      span: [71, 120],
    },
    // single-line payload: renderPayload emits `> quote anchor` (anchor inline)
    { id: "one-liner", type: "payload", statement: "log_level: info", span: [121, 140] },
  ],
  edges: [{ from: "timeout", to: "must-hold", rel: "precondition-for", span: [71, 120] }],
};

test("reader recovers a multi-line Payload fence's BARE trailing anchor (regression)", () => {
  const note = parseCanonicalNote(bodyOf(projectMarkdown(NOTE)));
  const multi = note.payload.find((p) => p.headword === "default config")!;
  expect(multi.body).toBe("timeout: 5000\nretries: 3");
  // the bug: stripAnchor could not read the bare `71..120` line, so span came back null.
  expect(multi.span).toEqual([71, 120]);
});

test("reader recovers a single-line Payload's inline anchor", () => {
  const note = parseCanonicalNote(bodyOf(projectMarkdown(NOTE)));
  const one = note.payload.find((p) => p.headword === "one-liner")!;
  expect(one.body).toBe("log_level: info");
  expect(one.span).toEqual([121, 140]);
});

test("reader strips the (modality) tag and recovers concept/judgement spans", () => {
  const note = parseCanonicalNote(bodyOf(projectMarkdown(NOTE)));
  expect(note.concepts[0]).toMatchObject({ headword: "timeout", span: [10, 40] });
  expect(note.judgements[0]).toEqual({
    statement: "the deadline must exceed zero",
    span: [41, 70],
  });
  expect(note.relations[0]).toContain("timeout — precondition-for → must-hold");
});

test("reader recovers per-bullet and per-step spans the projector emits (round-trip)", () => {
  const NOTE2: Projection = {
    source: { path: "sub.md", bytes: 300, sha256: "abc123abc123" },
    title: "Sub-spans",
    units: [
      {
        id: "Term",
        type: "concept",
        statement: "the definition\nfirst property\nsecond property",
        span: [0, 14],
        subSpans: [
          [15, 29],
          [30, 45],
        ],
      },
      {
        id: "Do it",
        type: "procedure",
        statement: "lead step\ntail step\nsynthesized step",
        span: [50, 60],
        // second tail step is a null hole → rendered unanchored
        subSpans: [[61, 70], null],
      },
    ],
    edges: [],
  };
  const note = parseCanonicalNote(bodyOf(projectMarkdown(NOTE2)));
  const concept = note.concepts.find((c) => c.headword === "Term")!;
  expect(concept.span).toEqual([0, 14]);
  expect(concept.bullets).toEqual(["first property", "second property"]);
  expect(concept.bulletSpans).toEqual([
    [15, 29],
    [30, 45],
  ]);
  const proc = note.procedures.find((p) => p.headword === "Do it")!;
  expect(proc.steps).toEqual(["lead step", "tail step", "synthesized step"]);
  // stepSpans[0] === the lead span; the null hole comes back as null (anchor dropped on render)
  expect(proc.stepSpans).toEqual([[50, 60], [61, 70], null]);
  expect(proc.span).toEqual([50, 60]);
});

// ---- fence-aware subsections() regression ----
test("parseCanonicalNote: a ###-look-alike line inside a fenced Payload block stays inside one entry (fence-unaware bug, fixed)", () => {
  const body = [
    "## Payload",
    "",
    "### snippet",
    "",
    "```js",
    "### not a real header, just a JS comment style line",
    "code();",
    "```",
    "71..120",
  ].join("\n");
  const note = parseCanonicalNote(body);
  expect(note.payload).toHaveLength(1);
  expect(note.payload[0]!.headword).toBe("snippet");
  expect(note.payload[0]!.body).toBe(
    "### not a real header, just a JS comment style line\ncode();",
  );
  expect(note.payload[0]!.span).toEqual([71, 120]);
});

// ---- stripAnchor recognizes the bracketed anchor form, not just the bare one ----
// stripAnchor delegates to graph.ts's shared stripTrailingAnchor, whose TRAILING_ANCHOR_RE
// matches both the bare `start..end` and the bracketed `[start..end]` form. A hand-rolled
// bare-only regex here would leave a bracketed anchor unparsed AND visible in the text: `text`
// would keep the literal brackets (`"...[128..192]"`) and `span` would come back null.
test("parseCanonicalNote: a concept def line and a judgement line ending in a BRACKETED anchor both strip the brackets and parse the span", () => {
  const body = [
    "## Concepts",
    "",
    "### alpha",
    "",
    "first letter [128..192]",
    "",
    "## Judgements",
    "",
    "- a hand-edited statement [128..192]",
  ].join("\n");
  const note = parseCanonicalNote(body);
  expect(note.concepts).toEqual([
    { headword: "alpha", def: "first letter", bullets: [], bulletSpans: [], span: [128, 192] },
  ]);
  expect(note.judgements).toEqual([{ statement: "a hand-edited statement", span: [128, 192] }]);
});

// ---- hand-dropped anchors (span: null) at each site ----
test("parseCanonicalNote: a concept def line missing its anchor still parses def, span is null", () => {
  const body = "## Concepts\n\n### alpha\n\nfirst letter, no anchor here";
  const note = parseCanonicalNote(body);
  expect(note.concepts).toEqual([
    {
      headword: "alpha",
      def: "first letter, no anchor here",
      bullets: [],
      bulletSpans: [],
      span: null,
    },
  ]);
});

test("parseCanonicalNote: a procedure lead step missing its anchor still parses steps, span is null", () => {
  const body = "## Procedures\n\n### proc\n\n1. step one no anchor\n2. step two 6..10";
  const note = parseCanonicalNote(body);
  expect(note.procedures).toEqual([
    {
      headword: "proc",
      steps: ["step one no anchor", "step two"],
      stepSpans: [null, [6, 10]],
      span: null,
    },
  ]);
});

test("parseCanonicalNote: a judgement/inference statement missing its anchor still parses, span is null", () => {
  const body = "## Judgements\n\n- a bare statement no anchor";
  const note = parseCanonicalNote(body);
  expect(note.judgements).toEqual([{ statement: "a bare statement no anchor", span: null }]);
});

// ---- malformed ### headers: silently dropped, not recovered, never throws ----
test("parseCanonicalNote: a malformed ### header (no space after hashes) is silently dropped, not recovered", () => {
  const body = "## Concepts\n\n###nospace\n\nsome def 1..5";
  expect(() => parseCanonicalNote(body)).not.toThrow();
  expect(parseCanonicalNote(body).concepts).toEqual([]);
});

test("parseCanonicalNote: a malformed ### header (four hashes) is silently dropped", () => {
  const body = "## Concepts\n\n#### toodeep\n\nsome def 1..5";
  expect(parseCanonicalNote(body).concepts).toEqual([]);
});

test("parseCanonicalNote: an indented ### header is silently dropped (not subsection-anchored)", () => {
  const body = "## Concepts\n\n  ### indented\n\nsome def 1..5";
  expect(parseCanonicalNote(body).concepts).toEqual([]);
});

// ---- empty-def hardening (mirrors prose-mode.ts::parseDistilled, pure.test.ts:653-664) ----
test("parseCanonicalNote: back-to-back ### headers drop the empty-def concept, keep the one with a def", () => {
  const body = "## Concepts\n\n### alpha\n### beta\n\nbeta def 6..10";
  const note = parseCanonicalNote(body);
  expect(note.concepts).toEqual([
    { headword: "beta", def: "beta def", bullets: [], bulletSpans: [], span: [6, 10] },
  ]);
});

test("parseCanonicalNote: a concept with only bullets and no def line is dropped, not surfaced with def ''", () => {
  const body = "## Concepts\n\n### gamma\n\n- only a bullet, no anchor";
  expect(parseCanonicalNote(body).concepts).toEqual([]);
});

test("parseCanonicalNote: a procedure with a headword but no numbered steps is dropped, not surfaced with steps: []", () => {
  const body = "## Procedures\n\n### proc\n\nno numbered lines here";
  expect(parseCanonicalNote(body).procedures).toEqual([]);
});
