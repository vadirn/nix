// project.test.ts — tests for the seven-section markdown projector (project.ts) against the
// spec's two worked examples (distill-spec §3, "Reference render 1/2"). Pure formatting; no
// mdstruct binary needed. Run with `bun test project.test.ts` from this directory.
import { expect, test } from "bun:test";
import { projectMarkdown, type Projection } from "./project.ts";

// Reference render 1 — "Record dates, not booleans": Abstract, two concept subsections, one
// (assertoric) judgement, one inference using ⇐, a procedure subsection with numbered steps,
// and one relation. No Payload section (the source carries no code/table/quote).
const RENDER_1: Projection = {
  source: { path: "record-dates-not-booleans.txt", bytes: 547, sha256: "965c0afefb91" },
  title: "Record dates, not booleans",
  abstract:
    "A nullable timestamp carries strictly more than a boolean and costs no more,\nso state fields should record when a transition happened, not merely whether.",
  units: [
    {
      id: "Boolean flag",
      type: "concept",
      statement:
        'A field recording only whether a state holds — true or false.\nanswers only "is it?"',
      span: [33, 47],
      subSpans: [[191, 222]],
    },
    {
      id: "Nullable timestamp",
      type: "concept",
      statement:
        'A field recording when a state transition occurred; null means not-yet.\nanswers "is it, and when?", and null still means no',
      span: [7, 27],
      subSpans: [[224, 287]],
    },
    {
      id: "no extra column",
      type: "judgment",
      statement: "the timestamp approach needs no extra column over the boolean",
      span: [443, 547],
      // no modality -> assertoric -> no tag
    },
    {
      id: "dominates",
      type: "inference",
      statement: "recording the date dominates the flag ⇐ the timestamp subsumes the boolean",
      span: [443, 547],
    },
    {
      id: "Model a state flag",
      type: "procedure",
      statement:
        'store the moment it happened, not a true/false\ntreat null as "not yet", non-null as "reached, at T"',
      span: [143, 189],
    },
  ],
  edges: [{ from: "Nullable timestamp", to: "Boolean flag", rel: "subsumes", span: [289, 442] }],
};

test("render 1: frontmatter mirrors mdstruct Source and declares the projection schema", () => {
  const md = projectMarkdown(RENDER_1);
  expect(md.startsWith("---\ntype: distillation\n")).toBe(true);
  expect(md).toContain(
    "source: { path: record-dates-not-booleans.txt, bytes: 547, sha256: 965c0afefb91 }",
  );
  expect(md).toContain("schema: 1.0");
});

test("render 1: title then Abstract (the only unanchored block)", () => {
  const md = projectMarkdown(RENDER_1);
  expect(md).toContain("# Record dates, not booleans");
  expect(md).toContain("## Abstract\n\nA nullable timestamp carries strictly more than a boolean");
  // the abstract line carries no trailing byte-span anchor
  expect(md).not.toMatch(/not merely whether\.\s+\d+\.\.\d+/);
});

test("render 1: sections appear in the fixed seven-section order, Payload omitted", () => {
  const md = projectMarkdown(RENDER_1);
  const order = [
    "## Abstract",
    "## Concepts",
    "## Judgements",
    "## Inferences",
    "## Procedures",
    "## Relations",
  ];
  const positions = order.map((h) => md.indexOf(h));
  expect(positions.every((p) => p >= 0)).toBe(true);
  const sorted = [...positions].sort((a, b) => a - b);
  expect(positions).toEqual(sorted);
  // no Payload unit -> no Payload section (absence is diagnostic, never an empty section)
  expect(md).not.toContain("## Payload");
});

test("render 1: concept subsections carry a heading, a definition line, and a PER-BULLET-anchored extension", () => {
  const md = projectMarkdown(RENDER_1);
  expect(md).toContain("### Boolean flag");
  expect(md).toContain("A field recording only whether a state holds — true or false. 33..47");
  // the extension bullet carries its OWN span (191..222), not the definition's (33..47)
  expect(md).toContain('- answers only "is it?" 191..222');
  expect(md).toContain("### Nullable timestamp");
  expect(md).toContain(
    "A field recording when a state transition occurred; null means not-yet. 7..27",
  );
  expect(md).toContain('- answers "is it, and when?", and null still means no 224..287');
});

test("render 1: an assertoric judgement emits no modality tag", () => {
  const md = projectMarkdown(RENDER_1);
  expect(md).toContain("- the timestamp approach needs no extra column over the boolean 443..547");
  const judgeLine = md.split("\n").find((l) => l.includes("no extra column over the boolean"))!;
  expect(judgeLine).not.toContain("(hypothesis)");
  expect(judgeLine).not.toContain("(necessarily)");
  expect(judgeLine.startsWith("- (")).toBe(false);
});

test("render 1: inference bullet may carry the ⇐ operator, anchored", () => {
  const md = projectMarkdown(RENDER_1);
  expect(md).toContain(
    "- recording the date dominates the flag ⇐ the timestamp subsumes the boolean 443..547",
  );
});

test("render 1: procedure subsection numbers steps, lead step anchored", () => {
  const md = projectMarkdown(RENDER_1);
  expect(md).toContain("### Model a state flag");
  expect(md).toContain("1. store the moment it happened, not a true/false 143..189");
  expect(md).toContain('2. treat null as "not yet", non-null as "reached, at T"');
});

test("render 1: the relation line is exact (em-dash, arrow, two spaces before the anchor)", () => {
  const md = projectMarkdown(RENDER_1);
  expect(md).toContain("## Relations");
  expect(md).toContain("- nullable timestamp — subsumes → boolean flag  289..442");
});

test("render 1: no empty sections are emitted", () => {
  const md = projectMarkdown(RENDER_1);
  // an emitted heading is always followed by content, never by a blank line then another heading
  expect(md).not.toMatch(/## [A-Za-z]+\n\n(?:## |#(?!#)|---|$)/);
});

test("relations: false suppresses ## Relations but keeps every other section (--reference, D30)", () => {
  // The --reference output path: pointer notes stay link-free, but the ## Abstract orientation and
  // the concept/judgement/inference/procedure sections all survive.
  const md = projectMarkdown(RENDER_1, { relations: false });
  expect(md).not.toContain("## Relations");
  // the relation line itself is gone (the word "subsumes" still occurs in the inference statement)
  expect(md).not.toContain("- nullable timestamp — subsumes → boolean flag");
  expect(md).toContain("## Abstract");
  expect(md).toContain("### Boolean flag");
  expect(md).toContain("## Judgements");
  expect(md).toContain("## Inferences");
  expect(md).toContain("### Model a state flag");
});

test("relations defaults true — omitting the opt is identical to relations: true", () => {
  expect(projectMarkdown(RENDER_1)).toBe(projectMarkdown(RENDER_1, { relations: true }));
  expect(projectMarkdown(RENDER_1)).toContain("## Relations");
});

// Reference render 2 — "Chesterton's Fence": exercises a (necessarily) apodictic judgement and
// a Payload blockquote with its anchor.
const RENDER_2: Projection = {
  source: { path: "chestertons-fence.txt", bytes: 493, sha256: "75ab3e59771c" },
  title: "Chesterton's Fence",
  units: [
    {
      id: "must not remove an unexplained constraint",
      type: "judgment",
      statement: "if you cannot state a constraint's use, you must not remove it",
      span: [184, 261],
      modality: "necessarily",
    },
    {
      id: "Reformer's line",
      type: "payload",
      statement: '"I don\'t see the use of this; let us clear it away."',
      span: [110, 162],
    },
  ],
  edges: [],
};

test("render 2: a (necessarily) judgement carries the apodictic modality tag", () => {
  const md = projectMarkdown(RENDER_2);
  expect(md).toContain("## Judgements");
  expect(md).toContain(
    "- (necessarily) if you cannot state a constraint's use, you must not remove it 184..261",
  );
});

test("render 2: Payload renders a `### key` + anchored blockquote of the verbatim slice", () => {
  const md = projectMarkdown(RENDER_2);
  expect(md).toContain("## Payload");
  expect(md).toContain("### Reformer's line");
  expect(md).toContain('> "I don\'t see the use of this; let us clear it away." 110..162');
});

test("render 2: no Concepts / Inferences / Procedures / Relations sections (no such units/edges)", () => {
  const md = projectMarkdown(RENDER_2);
  expect(md).not.toContain("## Concepts");
  expect(md).not.toContain("## Inferences");
  expect(md).not.toContain("## Procedures");
  expect(md).not.toContain("## Relations");
  // Judgements before Payload
  expect(md.indexOf("## Judgements")).toBeLessThan(md.indexOf("## Payload"));
});

// Focused unit tests for the omission and modality invariants.
test("a section with no units of that type is omitted entirely", () => {
  const onlyJudgement: Projection = {
    source: { path: "x.txt", bytes: 10, sha256: "deadbeef" },
    title: "X",
    units: [{ id: "j", type: "judgment", statement: "a claim", span: [0, 5] }],
    edges: [],
  };
  const md = projectMarkdown(onlyJudgement);
  expect(md).toContain("## Judgements");
  for (const h of [
    "## Concepts",
    "## Inferences",
    "## Procedures",
    "## Payload",
    "## Relations",
    "## Abstract",
  ]) {
    expect(md).not.toContain(h);
  }
});

test("a hypothesis judgement carries the problematic modality tag", () => {
  const hypo: Projection = {
    source: { path: "x.txt", bytes: 10, sha256: "deadbeef" },
    title: "X",
    units: [
      { id: "h", type: "judgment", statement: "maybe true", span: [0, 5], modality: "hypothesis" },
    ],
    edges: [],
  };
  expect(projectMarkdown(hypo)).toContain("- (hypothesis) maybe true 0..5");
});

test("an off-registry edge rel is a hard failure", () => {
  const bad: Projection = {
    source: { path: "x.txt", bytes: 10, sha256: "deadbeef" },
    title: "X",
    units: [
      { id: "A", type: "concept", statement: "a", span: [0, 1] },
      { id: "B", type: "concept", statement: "b", span: [1, 2] },
    ],
    edges: [{ from: "A", to: "B", rel: "causes", span: [0, 2] }],
  };
  expect(() => projectMarkdown(bad)).toThrow(/REL_REGISTRY/);
});

test("flat-bullet sections (judgements/inferences) join bullets tight (\\n), not blank-line separated", () => {
  const multi: Projection = {
    source: { path: "x.txt", bytes: 10, sha256: "deadbeef" },
    title: "X",
    units: [
      { id: "J1", type: "judgment", statement: "first claim", span: [0, 1] },
      { id: "J2", type: "judgment", statement: "second claim", span: [1, 2] },
      { id: "I1", type: "inference", statement: "first derivation", span: [2, 3] },
      { id: "I2", type: "inference", statement: "second derivation", span: [3, 4] },
    ],
    edges: [],
  };
  const md = projectMarkdown(multi);
  // adjacent judgement bullets are one line apart (tight), matching ## Relations — not stanzas
  expect(md).toContain("- first claim 0..1\n- second claim 1..2");
  expect(md).toContain("- first derivation 2..3\n- second derivation 3..4");
});

test("multi-part sections (concepts) keep the blank-line join between subsections", () => {
  const concepts: Projection = {
    source: { path: "x.txt", bytes: 10, sha256: "deadbeef" },
    title: "X",
    units: [
      { id: "A", type: "concept", statement: "def a", span: [0, 1] },
      { id: "B", type: "concept", statement: "def b", span: [1, 2] },
    ],
    edges: [],
  };
  const md = projectMarkdown(concepts);
  // concept subsections stay stanza-separated (a `### A` block, blank line, then `### B`)
  expect(md).toContain("### A\n\ndef a 0..1\n\n### B\n\ndef b 1..2");
});

test("per-step spans: every procedure step past the lead is anchored by its own subSpan", () => {
  const proc: Projection = {
    source: { path: "x.txt", bytes: 100, sha256: "deadbeef" },
    title: "X",
    units: [
      {
        id: "Do the thing",
        type: "procedure",
        statement: "first step\nsecond step\nthird step",
        span: [0, 10],
        subSpans: [
          [11, 22],
          [23, 33],
        ],
      },
    ],
    edges: [],
  };
  const md = projectMarkdown(proc);
  expect(md).toContain("1. first step 0..10");
  expect(md).toContain("2. second step 11..22");
  expect(md).toContain("3. third step 23..33");
});

test("per-step spans: a null subSpan hole renders that step unanchored (synthesized step)", () => {
  const proc: Projection = {
    source: { path: "x.txt", bytes: 100, sha256: "deadbeef" },
    title: "X",
    units: [
      {
        id: "Model a state flag",
        type: "procedure",
        statement: "store the moment, not a flag\ntreat null as not-yet",
        span: [143, 189],
        subSpans: [null],
      },
    ],
    edges: [],
  };
  const md = projectMarkdown(proc);
  expect(md).toContain("1. store the moment, not a flag 143..189");
  // the null hole → no trailing anchor on the synthesized step
  expect(md).toContain("2. treat null as not-yet");
  expect(md).not.toMatch(/2\. treat null as not-yet\s+\d+\.\.\d+/);
});

test("per-bullet spans: a concept with multiple extension bullets anchors each independently", () => {
  const concept: Projection = {
    source: { path: "x.txt", bytes: 100, sha256: "deadbeef" },
    title: "X",
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
    ],
    edges: [],
  };
  const md = projectMarkdown(concept);
  expect(md).toContain("the definition 0..14");
  expect(md).toContain("- first property 15..29");
  expect(md).toContain("- second property 30..45");
});

test("per-bullet spans: with no subSpans, extension bullets render unanchored (no def-span reuse)", () => {
  const concept: Projection = {
    source: { path: "x.txt", bytes: 100, sha256: "deadbeef" },
    title: "X",
    units: [
      {
        id: "Term",
        type: "concept",
        statement: "the definition\na bullet with no located quote",
        span: [0, 14],
      },
    ],
    edges: [],
  };
  const md = projectMarkdown(concept);
  expect(md).toContain("the definition 0..14");
  // the bullet is present but bears no anchor — the def's span is NOT reused for it
  expect(md).toContain("- a bullet with no located quote");
  expect(md).not.toMatch(/- a bullet with no located quote\s+\d+\.\.\d+/);
});

test("title falls back to the source path basename when none is given", () => {
  const noTitle: DistillationResultLike = {
    source: { path: "notes/some-idea.md", bytes: 10, sha256: "deadbeef" },
    units: [{ id: "j", type: "judgment", statement: "a claim", span: [0, 5] }],
    edges: [],
  };
  expect(projectMarkdown(noTitle)).toContain("# Some idea");
});

type DistillationResultLike = Parameters<typeof projectMarkdown>[0];
