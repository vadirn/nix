// grammar.test.ts — the on-disk wire-format pin (R2). The seven-section projection is the
// canonical note's ONLY interchange format: project.ts writes it, and parse-projection.ts,
// cards, prose, and apply all read it back off disk. The other projection tests feed
// projectMarkdown(graph) straight into the reader, so a drift in anchor spacing or the Payload
// fence would co-evolve on both sides and stay green while notes saved on disk silently broke.
//
// This suite breaks that loop with a CHECKED-IN golden note (fixtures/canonical-golden.md):
//   - the EMIT pin asserts projectMarkdown(GOLDEN) reproduces the frozen bytes, so a projector
//     drift fails loudly and the fixture is only ever regenerated on purpose;
//   - the READ pins parse those FROZEN bytes (never projectMarkdown's live output) and assert
//     hand-written structures, so a reader that stops understanding the grammar fails here.
// Regenerate the fixture only when the format changes intentionally:
//   bun -e 'import {projectMarkdown} from "@/graph/project.ts"; import {GOLDEN} from "@/grammar.test.ts";
//           await Bun.write("fixtures/canonical-golden.md", projectMarkdown(GOLDEN))'
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "bun:test";
import { projectMarkdown, type Projection } from "@/graph/project.ts";
import { parseCanonicalNote } from "@/graph/parse-projection.ts";
import { harvestConcepts } from "@/cards/cards.ts";
import { parseDistilled } from "@/app/prose-mode.ts";

// The one graph the golden fixture is emitted from — exercises every section and both Payload
// forms (a single-line blockquote and a multi-line fence whose body holds a `### `-lookalike line
// that must stay INSIDE its entry, the fence-aware reader's load-bearing case), all three
// modalities, an inference with ⇐, and a relation.
export const GOLDEN: Projection = {
  source: { path: "canonical-grammar.txt", bytes: 812, sha256: "a1b2c3d4e5f6" },
  title: "Canonical projection grammar",
  abstract:
    "The seven-section projection is a fixed wire format: every reader parses these\nbytes, so their spacing, anchors, and fences must stay frozen as a golden fixture.",
  units: [
    {
      id: "Wire format",
      type: "concept",
      statement:
        "A byte layout a writer and every reader agree on.\nchanging it silently breaks the readers",
      span: [10, 44],
      subSpans: [[210, 252]],
    },
    {
      id: "Golden fixture",
      type: "concept",
      statement: "A checked-in expected output frozen as bytes, regenerated only on purpose.",
      span: [46, 88],
    },
    {
      id: "readers share one grammar",
      type: "judgment",
      statement: "every reader parses the same emitted grammar",
      span: [300, 360],
    },
    {
      id: "drift must fail loudly",
      type: "judgment",
      statement: "a format drift must fail a test, never pass silently",
      span: [362, 420],
      modality: "necessarily",
    },
    {
      id: "one fixture may suffice",
      type: "judgment",
      statement: "a single golden note may cover the whole grammar",
      span: [422, 470],
      modality: "hypothesis",
    },
    {
      id: "pin both directions",
      type: "inference",
      statement: "freezing the bytes pins emit and read at once ⇐ both sides diff the same file",
      span: [472, 540],
    },
    {
      id: "Add a golden test",
      type: "procedure",
      statement:
        "emit the graph and write the bytes to a fixture\nassert the projector reproduces the fixture\nassert every reader parses the fixture",
      span: [560, 610],
      subSpans: [
        [612, 650],
        [652, 700],
      ],
    },
    {
      id: "the one-liner",
      type: "payload",
      statement: "freeze the bytes, not the function that made them.",
      span: [702, 752],
    },
    {
      id: "sample fence",
      type: "payload",
      statement: "### not a heading\nprojectMarkdown(graph) === readFileSync(fixture)",
      span: [760, 812],
    },
  ],
  edges: [{ from: "Golden fixture", to: "Wire format", rel: "pins", span: [90, 160] }],
};

const FIXTURE = resolve(import.meta.dir, "fixtures", "canonical-golden.md");
const goldenBytes = readFileSync(FIXTURE, "utf8");
const bodyOf = (md: string) => md.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/)![1]!;
const goldenBody = bodyOf(goldenBytes);

// ---- EMIT pin: the projector reproduces the frozen bytes exactly ----
test("emit: projectMarkdown(GOLDEN) reproduces the checked-in golden note byte-for-byte", () => {
  expect(projectMarkdown(GOLDEN)).toBe(goldenBytes);
});

// ---- READ pins: every reader recovers the grammar from the FROZEN bytes ----
test("read/parseCanonicalNote: sections, anchors, and per-bullet/step spans recover from disk", () => {
  const note = parseCanonicalNote(goldenBody);

  expect(note.abstract).toContain("The seven-section projection is a fixed wire format");

  expect(note.concepts.map((c) => c.headword)).toEqual(["Wire format", "Golden fixture"]);
  expect(note.concepts[0]!.def).toBe("A byte layout a writer and every reader agree on.");
  expect(note.concepts[0]!.span).toEqual([10, 44]);
  expect(note.concepts[0]!.bullets).toEqual(["changing it silently breaks the readers"]);
  expect(note.concepts[0]!.bulletSpans).toEqual([[210, 252]]);
  expect(note.concepts[1]!.bullets).toEqual([]);

  expect(note.judgements).toHaveLength(3);
  expect(note.judgements[1]!.statement).toContain("must fail a test"); // the (necessarily) bullet
  expect(note.judgements[1]!.span).toEqual([362, 420]);

  expect(note.inferences).toHaveLength(1);
  expect(note.inferences[0]!.statement).toContain("⇐");
  expect(note.inferences[0]!.span).toEqual([472, 540]);

  expect(note.procedures).toHaveLength(1);
  expect(note.procedures[0]!.headword).toBe("Add a golden test");
  expect(note.procedures[0]!.steps).toHaveLength(3);
  expect(note.procedures[0]!.stepSpans).toEqual([
    [560, 610],
    [612, 650],
    [652, 700],
  ]);

  // the fence-aware case: TWO payload entries, and the `### `-lookalike inside the fence did NOT
  // split "sample fence" into a phantom third entry.
  expect(note.payload.map((p) => p.headword)).toEqual(["the one-liner", "sample fence"]);
  expect(note.payload[0]!.body).toBe("freeze the bytes, not the function that made them.");
  expect(note.payload[0]!.span).toEqual([702, 752]);
  expect(note.payload[1]!.body).toContain("### not a heading");
  expect(note.payload[1]!.body).toContain("projectMarkdown(graph) === readFileSync(fixture)");
  expect(note.payload[1]!.span).toEqual([760, 812]);

  expect(note.relations).toHaveLength(1);
  expect(note.relations[0]).toContain("pins");
});

test("read/cards.harvestConcepts: recovers concept term/def and attaches the relation from disk", () => {
  const harvested = harvestConcepts(goldenBody);
  expect(harvested.map((c) => c.term)).toEqual(["Wire format", "Golden fixture"]);
  expect(harvested[0]!.def).toBe("A byte layout a writer and every reader agree on.");
  // the `golden fixture — pins → wire format` edge attaches to its from-concept
  expect(harvested[1]!.relations).toEqual([{ rel: "pins", to: "wire format", predicate: null }]);
});

test("read/prose.parseDistilled: recovers the thesis, glossary entries, and preserved sections from disk", () => {
  const { tie, entries, preserved } = parseDistilled(goldenBody);
  expect(tie).toContain("fixed wire format");
  expect(entries).toEqual([
    { term: "Wire format", def: "A byte layout a writer and every reader agree on." },
    {
      term: "Golden fixture",
      def: "A checked-in expected output frozen as bytes, regenerated only on purpose.",
    },
  ]);
  // the non-concept sections ride through prose mode verbatim as preserved payload
  expect(preserved).toContain("## Payload");
  expect(preserved).toContain("### not a heading");
});
