// e2e.test.ts — end-to-end of the canonical projection path WITHOUT a live model: a fixture body
// + a fixture settled combo (real verbatim quotes) → comboToResult → projectMarkdown. Asserts
// the frontmatter Source, that the expected sections populate, that every emitted start..end
// anchor round-trips against the body bytes, and that Relations render `from — rel → to`.
// Negative: an absent quote hard-aborts (LocateError); an off-registry rel and a no-unit
// endpoint are dropped. Run with `bun test e2e.test.ts`.
import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { comboToResult, type ComboToResultArgs } from "./adapt.ts";
import { computeSource } from "./graph.ts";
import { LocateError } from "./locate.ts";
import { sliceBytes } from "./mdstruct.ts";
import { computeStepGroups } from "./pipeline.ts";
import { projectMarkdown } from "./project.ts";
import type { Block, Combo, GlossEntry, WorkStep } from "./text.ts";

const PATH = "widgets.md";
const BODY = [
  "# Widgets and gadgets",
  "",
  "A widget is a small composable unit of work.",
  "A gadget is a larger assembly built from widgets.",
  "",
  "Every gadget depends on at least one widget, which is a strong claim.",
  "",
  "It follows that you cannot build a gadget with no widgets.",
  "",
  "First, assemble the widgets in order.",
  "Then bolt them together into a gadget.",
  "Finally, verify the assembly is sound.",
  "",
  "const answer = 42;",
].join("\n");

const orderedEntries: GlossEntry[] = [
  {
    term: "Widget",
    def: "raw",
    quote: "A widget is a small composable unit of work.",
    source: ["B1"],
    relations: [],
  },
  {
    term: "Gadget",
    def: "raw",
    quote: "A gadget is a larger assembly built from widgets.",
    source: ["B2"],
    relations: [
      {
        rel: "depends-on",
        to: "Widget",
        predicate: null,
        quote: "gadget depends on at least one widget",
      },
      // off-registry rel → dropped before locate
      { rel: "causes", to: "Widget", predicate: null, quote: "unused" },
      // no local unit for endpoint → dropped before locate
      { rel: "part-of", to: "Missing", predicate: null, quote: "unused" },
    ],
  },
];
const defByTerm = new Map<string, string>([
  ["Widget", "A widget is a small composable unit."],
  ["Gadget", "A gadget is an assembly of widgets."],
]);
const orderedSteps: WorkStep[] = [
  { step: "s0", source: ["B7"], quote: "First, assemble the widgets in order." },
  { step: "s1", source: ["B7"], quote: "Then bolt them together into a gadget." },
];
const workflowSteps = ["Assemble the widgets in order.", "Bolt them together into a gadget."];
const blockById = new Map<string, Block>([["B7", { id: "B7", text: "steps source" }]]);
const payloadBlocks: Block[] = [{ id: "B9", text: "const answer = 42;" }];
const combo: Combo = {
  description: "",
  thesis: "",
  glossary: [],
  workflow: [],
  title: "Widgets and gadgets",
  abstract: "Widgets compose into gadgets.",
  judgements: [
    {
      statement: "Gadgets are reliable.",
      modality: null,
      source: ["B3"],
      quote: "Every gadget depends on at least one widget, which is a strong claim.",
    },
  ],
  inferences: [
    {
      statement: "Gadgets require widgets.",
      source: ["B4"],
      quote: "It follows that you cannot build a gadget with no widgets.",
    },
  ],
};

function args(overrides: Partial<ComboToResultArgs> = {}): ComboToResultArgs {
  return {
    path: PATH,
    body: BODY,
    combo,
    orderedEntries,
    orderedSteps,
    workflowSteps,
    defByTerm,
    payloadBlocks,
    stepGroups: computeStepGroups(orderedSteps, blockById),
    ...overrides,
  };
}

test("e2e: frontmatter bytes/sha256 equal computeSource(path, body)", () => {
  const md = projectMarkdown(comboToResult(args()));
  const src = computeSource(PATH, BODY);
  expect(md).toContain(`source: { path: ${src.path}, bytes: ${src.bytes}, sha256: ${src.sha256} }`);
});

test("e2e: the expected sections populate", () => {
  const md = projectMarkdown(comboToResult(args()));
  for (const heading of [
    "# Widgets and gadgets",
    "## Abstract",
    "## Concepts",
    "## Judgements",
    "## Inferences",
    "## Procedures",
    "## Payload",
    "## Relations",
  ]) {
    expect(md).toContain(heading);
  }
});

test("e2e: every emitted start..end anchor round-trips against the body bytes", () => {
  const md = projectMarkdown(comboToResult(args()));
  const buf = Buffer.from(BODY, "utf8");
  const anchors = [...md.matchAll(/(\d+)\.\.(\d+)/g)];
  expect(anchors.length).toBeGreaterThan(0);
  for (const m of anchors) {
    const span: [number, number] = [Number(m[1]), Number(m[2])];
    const slice = sliceBytes(buf, span);
    // a real verbatim slice: non-empty and present in the body it indexes into.
    expect(slice.length).toBeGreaterThan(0);
    expect(BODY).toContain(slice);
  }
});

test("e2e: a specific concept anchor round-trips to its verbatim quote", () => {
  const result = comboToResult(args());
  const widget = result.units.find((u) => u.id === "Widget")!;
  expect(sliceBytes(Buffer.from(BODY, "utf8"), widget.span)).toBe(
    "A widget is a small composable unit of work.",
  );
});

test("e2e: Relations render `from — rel → to`", () => {
  const md = projectMarkdown(comboToResult(args()));
  expect(md).toContain("gadget — depends-on → widget");
});

test("e2e: an off-registry rel and a no-unit endpoint are dropped (one edge survives)", () => {
  const result = comboToResult(args());
  expect(result.edges).toHaveLength(1);
  const md = projectMarkdown(result);
  const relationLines = md.split("\n").filter((l) => l.includes("→"));
  expect(relationLines).toHaveLength(1);
});

test("e2e: a quote absent from body hard-aborts with LocateError", () => {
  const badEntries: GlossEntry[] = [
    {
      term: "Ghost",
      def: "raw",
      quote: "this exact sentence is not present in the body",
      source: ["B1"],
      relations: [],
    },
  ];
  expect(() => comboToResult(args({ orderedEntries: badEntries }))).toThrow(LocateError);
});
