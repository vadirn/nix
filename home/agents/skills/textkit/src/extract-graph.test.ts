// extract-graph.test.ts — unit tests for parseExtractGraph (prompts.ts): the PURE normalizer that
// turns the raw pre-graph JSON into a typed PreGraph, without a network round-trip. Asserts the
// channel renames (concepts/headword/statement, grouped procedures), quote threading (trim-only,
// byte-verbatim), the drop-if-no-valid-source rule per channel, modality clamping, relation
// normalization with predicate dropped, and the frontDescription override. Run with `bun test`.
import { expect, test } from "bun:test";
import { parseExtractGraph, type RawGraph } from "textkit/distill/prompt/prompts.ts";
import type { Block } from "textkit/core/text.ts";

const BLOCKS: Block[] = [
  { id: "B1", text: "b1" },
  { id: "B2", text: "b2" },
  { id: "B3", text: "b3" },
  { id: "B4", text: "b4" },
];

function raw(overrides: Partial<RawGraph> = {}): RawGraph {
  return {
    title: "Widgets",
    abstract: "Widgets compose into gadgets.",
    description: "A note about widgets.",
    thesis: "Gadgets are built from widgets.",
    concepts: [
      {
        headword: "Widget",
        statement: "a small composable unit",
        quote: "  A widget is a small unit.  ",
        relations: [],
        source: ["B1"],
      },
      {
        headword: "Gadget",
        statement: "an assembly of widgets",
        quote: "A gadget is an assembly.",
        relations: [
          {
            rel: "Depends On",
            to: "Widget",
            predicate: "some gloss",
            quote: "gadget depends on a widget",
          },
        ],
        source: ["B2"],
      },
    ],
    judgements: [
      {
        statement: "Gadgets are reliable.",
        modality: null,
        quote: "reliable claim",
        source: ["B3"],
      },
    ],
    inferences: [
      { statement: "Gadgets require widgets.", quote: "it follows that", source: ["B4"] },
    ],
    procedures: [
      {
        headword: "Assemble",
        steps: [
          { statement: "assemble the widgets", quote: "assemble the widgets", source: ["B1"] },
          { statement: "bolt them together", quote: "bolt them together", source: ["B2"] },
        ],
      },
    ],
    ...overrides,
  };
}

test("parseExtractGraph carries the document-level fields", () => {
  const pre = parseExtractGraph(raw(), BLOCKS);
  expect(pre.title).toBe("Widgets");
  expect(pre.abstract).toBe("Widgets compose into gadgets.");
  expect(pre.description).toBe("A note about widgets.");
  expect(pre.thesis).toBe("Gadgets are built from widgets.");
});

test("concepts: headword → id, statement kept, quote trimmed byte-verbatim (no typography normalize)", () => {
  const pre = parseExtractGraph(raw(), BLOCKS);
  const widget = pre.concepts.find((c) => c.id === "Widget")!;
  expect(widget.type).toBe("concept");
  expect(widget.statement).toBe("a small composable unit");
  // trim only — inner spacing/glyphs untouched
  expect(widget.quote).toBe("A widget is a small unit.");
});

test("concepts: extension bullets populate PreUnit.bullets (statement kept, quote trim-only)", () => {
  const pre = parseExtractGraph(
    raw({
      concepts: [
        {
          headword: "Widget",
          statement: "a small composable unit",
          quote: "A widget is a small unit.",
          bullets: [
            { statement: "composes into gadgets", quote: "  widgets compose into gadgets  " },
            { statement: "", quote: "dropped — empty statement" },
          ],
          source: ["B1"],
        },
      ],
    }),
    BLOCKS,
  );
  const widget = pre.concepts.find((c) => c.id === "Widget")!;
  // the empty-statement bullet is dropped; the real one is kept with a trim-only quote
  expect(widget.bullets).toEqual([
    { statement: "composes into gadgets", quote: "widgets compose into gadgets" },
  ]);
});

test("concepts: a concept with no bullets leaves PreUnit.bullets undefined", () => {
  const pre = parseExtractGraph(raw(), BLOCKS);
  expect(pre.concepts.find((c) => c.id === "Widget")!.bullets).toBeUndefined();
});

test("relations become flat PreEdges owned by the headword; rel normalized, predicate dropped", () => {
  const pre = parseExtractGraph(raw(), BLOCKS);
  expect(pre.edges).toHaveLength(1);
  const e = pre.edges[0];
  expect(e.fromHeadword).toBe("Gadget");
  expect(e.rel).toBe("depends-on"); // lowercased + hyphenated by normalizeRelation
  expect(e.to).toBe("Widget");
  expect(e.quote).toBe("gadget depends on a widget");
  // predicate is not part of PreEdge at all
  expect((e as unknown as Record<string, unknown>).predicate).toBeUndefined();
});

test("judgements: modality clamps to the two marked forms, else assertoric", () => {
  const pre = parseExtractGraph(
    raw({
      judgements: [
        { statement: "plain", modality: null, quote: "q1 plain", source: ["B1"] },
        { statement: "maybe", modality: "hypothesis", quote: "q2 maybe", source: ["B1"] },
        { statement: "must", modality: "necessarily", quote: "q3 must", source: ["B1"] },
        { statement: "junk", modality: "whatever", quote: "q4 junk", source: ["B1"] },
      ],
    }),
    BLOCKS,
  );
  expect(pre.judgements.map((j) => j.modality)).toEqual([
    "assertoric",
    "hypothesis",
    "necessarily",
    "assertoric",
  ]);
  expect(pre.judgements.every((j) => j.type === "judgment")).toBe(true);
});

test("inferences parse into inference PreUnits", () => {
  const pre = parseExtractGraph(raw(), BLOCKS);
  expect(pre.inferences).toHaveLength(1);
  expect(pre.inferences[0].type).toBe("inference");
  expect(pre.inferences[0].statement).toBe("Gadgets require widgets.");
  expect(pre.inferences[0].quote).toBe("it follows that");
});

test("procedures stay grouped with their headword and ordered steps", () => {
  const pre = parseExtractGraph(raw(), BLOCKS);
  expect(pre.procedures).toHaveLength(1);
  expect(pre.procedures[0].headword).toBe("Assemble");
  expect(pre.procedures[0].steps.map((s) => s.statement)).toEqual([
    "assemble the widgets",
    "bolt them together",
  ]);
  expect(pre.procedures[0].steps.every((s) => s.type === "procedure")).toBe(true);
});

test("drop-if-no-valid-source: a concept with no valid source id is dropped", () => {
  const pre = parseExtractGraph(
    raw({
      concepts: [
        { headword: "Kept", statement: "d", quote: "q kept", source: ["B1"] },
        { headword: "NoSource", statement: "d", quote: "q nosrc", source: [] },
        { headword: "BadSource", statement: "d", quote: "q badsrc", source: ["B99"] },
      ],
    }),
    BLOCKS,
  );
  expect(pre.concepts.map((c) => c.id)).toEqual(["Kept"]);
});

test("drop-if-no-valid-source: judgements and inferences follow the same rule", () => {
  const pre = parseExtractGraph(
    raw({
      judgements: [
        { statement: "kept", modality: null, quote: "q jk", source: ["B1"] },
        { statement: "dropped", modality: null, quote: "q jd", source: [] },
      ],
      inferences: [
        { statement: "kept", quote: "q ik", source: ["B2"] },
        { statement: "dropped", quote: "q id", source: ["B99"] },
      ],
    }),
    BLOCKS,
  );
  expect(pre.judgements.map((j) => j.statement)).toEqual(["kept"]);
  expect(pre.inferences.map((i) => i.statement)).toEqual(["kept"]);
});

test("procedures: unsourced steps drop; a group with no surviving step is dropped", () => {
  const pre = parseExtractGraph(
    raw({
      procedures: [
        {
          headword: "Mixed",
          steps: [
            { statement: "kept step", quote: "q ks", source: ["B1"] },
            { statement: "dropped step", quote: "q ds", source: [] },
          ],
        },
        {
          headword: "AllGone",
          steps: [{ statement: "s", quote: "q ag", source: ["B99"] }],
        },
      ],
    }),
    BLOCKS,
  );
  expect(pre.procedures).toHaveLength(1);
  expect(pre.procedures[0].headword).toBe("Mixed");
  expect(pre.procedures[0].steps.map((s) => s.statement)).toEqual(["kept step"]);
});

test("relations with rel or to missing are dropped (normalizeRelation LOSSY keep-rule)", () => {
  const pre = parseExtractGraph(
    raw({
      concepts: [
        {
          headword: "Gadget",
          statement: "d",
          quote: "q g",
          source: ["B1"],
          relations: [
            { rel: "depends-on", to: "Widget", quote: "good edge" },
            { rel: "", to: "Widget", quote: "no rel" },
            { rel: "part-of", to: "", quote: "no to" },
          ],
        },
      ],
    }),
    BLOCKS,
  );
  expect(pre.edges).toHaveLength(1);
  expect(pre.edges[0].quote).toBe("good edge");
});

test("frontDescription overrides the model's description", () => {
  const pre = parseExtractGraph(raw(), BLOCKS, "AUTHORED DESC");
  expect(pre.description).toBe("AUTHORED DESC");
});

test("empty / missing channels yield empty arrays, not throws", () => {
  const pre = parseExtractGraph({}, BLOCKS);
  expect(pre.concepts).toEqual([]);
  expect(pre.judgements).toEqual([]);
  expect(pre.inferences).toEqual([]);
  expect(pre.procedures).toEqual([]);
  expect(pre.edges).toEqual([]);
  expect(pre.title).toBe("");
});
