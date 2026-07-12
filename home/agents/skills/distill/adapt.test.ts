// adapt.test.ts — unit tests for comboToResult (adapt.ts): the end-of-pipeline adapter that
// rebuilds a canonical DistillationResult from distill()'s SETTLED artifacts. Pure: no network,
// no live model. Every quote in the fixtures is a real verbatim slice of BODY, so locate()
// resolves each to a self-consistent byte span. Run with `bun test adapt.test.ts`.
import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { comboToResult } from "./adapt.ts";
import { computeSource } from "./graph.ts";
import { sliceBytes } from "./mdstruct.ts";
import { computeStepGroups } from "./pipeline.ts";
import type { Block, Combo, GlossEntry, WorkStep } from "./text.ts";

const PATH = "widgets.md";
// The frontmatter-stripped body every span indexes into. Each quote below is a verbatim,
// UNIQUE substring of this string (locate throws on not-found / ambiguous).
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
  "",
  "const other = 7;",
].join("\n");

// Two concept entries. `def` is the raw extract def; defByTerm overrides it with the gate-settled
// def. `quote` is the verbatim source slice the concept was distilled from.
const orderedEntries: GlossEntry[] = [
  {
    term: "Widget",
    def: "raw widget def",
    quote: "A widget is a small composable unit of work.",
    source: ["B1"],
    relations: [],
  },
  {
    term: "Gadget",
    def: "raw gadget def",
    quote: "A gadget is a larger assembly built from widgets.",
    source: ["B2"],
    relations: [
      // retained: registry rel + endpoint resolves to the local "Widget" concept unit.
      {
        rel: "depends-on",
        to: "Widget",
        predicate: null,
        quote: "gadget depends on at least one widget",
      },
      // dropped: off-registry rel (bogus quote never reached — filter precedes locate).
      { rel: "causes", to: "Widget", predicate: null, quote: "NOT IN BODY AT ALL" },
      // dropped: registry rel but endpoint resolves to no local unit (bogus quote never reached).
      { rel: "part-of", to: "Nonexistent", predicate: null, quote: "NOT IN BODY EITHER" },
    ],
  },
];

const defByTerm = new Map<string, string>([
  ["Widget", "A widget is a small composable unit."],
  ["Gadget", "A gadget is an assembly of widgets."],
]);

// Three settled steps: the first two share source B7 (one group), the third is B8 (a second
// group) — computeStepGroups yields one procedure unit per group.
const orderedSteps: WorkStep[] = [
  { step: "s0", source: ["B7"], quote: "First, assemble the widgets in order." },
  { step: "s1", source: ["B7"], quote: "Then bolt them together into a gadget." },
  { step: "s2", source: ["B8"], quote: "Finally, verify the assembly is sound." },
];
const workflowSteps = [
  "Assemble the widgets in order.",
  "Bolt them together into a gadget.",
  "Verify the assembly is sound.",
];
const blockById = new Map<string, Block>([
  ["B7", { id: "B7", text: "assemble/bolt source" }],
  ["B8", { id: "B8", text: "verify source" }],
]);

// Two retained (payload) blocks — statement IS the verbatim slice; both are unique in BODY.
const payloadBlocks: Block[] = [
  { id: "B9", text: "const answer = 42;" },
  { id: "B10", text: "const other = 7;" },
];

const combo: Combo = {
  description: "",
  thesis: "",
  glossary: [],
  workflow: [],
  title: "Widgets and gadgets",
  abstract: "Widgets compose into gadgets.",
  // one judgement with an UNMARKED (null) modality → must map to "assertoric".
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

function run() {
  return comboToResult({
    path: PATH,
    body: BODY,
    combo,
    orderedEntries,
    orderedSteps,
    workflowSteps,
    defByTerm,
    payloadBlocks,
    stepGroups: computeStepGroups(orderedSteps, blockById),
  });
}

test("comboToResult: source is computed over body (bytes/sha256 via computeSource)", () => {
  const result = run();
  expect(result.source).toEqual(computeSource(PATH, BODY));
});

test("comboToResult: one payload unit per retained block, id = first meaningful line", () => {
  const result = run();
  const payload = result.units.filter((u) => u.type === "payload");
  expect(payload.length).toBe(payloadBlocks.length);
  expect(payload.map((u) => u.id)).toEqual(["const answer = 42;", "const other = 7;"]);
  // statement IS the verbatim block text, and the span round-trips to it.
  for (const u of payload) {
    expect(sliceBytes(Buffer.from(BODY, "utf8"), u.span)).toBe(u.statement);
  }
});

test("comboToResult: procedure grouping — one unit per computeStepGroups group", () => {
  const result = run();
  const procs = result.units.filter((u) => u.type === "procedure");
  expect(procs.length).toBe(2); // [s0,s1] share B7; [s2] is B8
  // the first group's statement joins its settled workflowSteps by newline; the span anchors
  // the lead step's quote.
  expect(procs[0].statement).toBe(
    "Assemble the widgets in order.\nBolt them together into a gadget.",
  );
  expect(sliceBytes(Buffer.from(BODY, "utf8"), procs[0].span)).toBe(
    "First, assemble the widgets in order.",
  );
  expect(procs[1].statement).toBe("Verify the assembly is sound.");
});

test("comboToResult: concept statement is the gate-settled def, span anchors the quote", () => {
  const result = run();
  const widget = result.units.find((u) => u.id === "Widget");
  expect(widget?.type).toBe("concept");
  expect(widget?.statement).toBe("A widget is a small composable unit."); // defByTerm override
  expect(sliceBytes(Buffer.from(BODY, "utf8"), widget!.span)).toBe(
    "A widget is a small composable unit of work.",
  );
});

test("comboToResult: an unmarked (null) judgement modality maps to assertoric", () => {
  const result = run();
  const j = result.units.find((u) => u.type === "judgment");
  expect(j?.id).toBe("J1");
  expect(j?.modality).toBe("assertoric");
});

test("comboToResult: edge filtering drops off-registry rel and no-unit endpoint", () => {
  const result = run();
  // Gadget carries three relations; only the depends-on → Widget survives.
  expect(result.edges).toHaveLength(1);
  const [edge] = result.edges;
  expect(edge.from).toBe("Gadget");
  expect(edge.to).toBe("Widget");
  expect(edge.rel).toBe("depends-on");
  expect(sliceBytes(Buffer.from(BODY, "utf8"), edge.span)).toBe(
    "gadget depends on at least one widget",
  );
});
