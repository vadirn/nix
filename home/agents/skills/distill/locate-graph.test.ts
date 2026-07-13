// locate-graph.test.ts — the locate stage (locate-graph.ts) without a live model: a fixture body +
// a hand-built PreGraph → locateGraph → projectMarkdown. Asserts the frontmatter Source, that the
// expected sections populate, that every emitted start..end anchor round-trips against the body
// bytes, that Relations render `from — rel → to`, and that the payload retain lane folds in.
// Negative: an absent quote hard-aborts (LocateError); an off-registry rel and a no-unit endpoint
// are dropped. Converges on the e2e.test.ts template (build the graph directly). Run with
// `bun test locate-graph.test.ts`.
import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { computeSource, type PreGraph } from "./graph.ts";
import { locateGraph } from "./locate-graph.ts";
import { LocateError } from "./locate.ts";
import { sliceBytes } from "./mdstruct.ts";
import { projectMarkdown } from "./project.ts";
import type { Block } from "./text.ts";

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

function pre(overrides: Partial<PreGraph> = {}): PreGraph {
  return {
    title: "Widgets and gadgets",
    abstract: "Widgets compose into gadgets.",
    description: "",
    thesis: "",
    concepts: [
      {
        type: "concept",
        id: "Widget",
        statement: "A widget is a small composable unit.",
        quote: "A widget is a small composable unit of work.",
      },
      {
        type: "concept",
        id: "Gadget",
        statement: "A gadget is an assembly of widgets.",
        quote: "A gadget is a larger assembly built from widgets.",
      },
    ],
    judgements: [
      {
        type: "judgment",
        statement: "Gadgets are reliable.",
        quote: "Every gadget depends on at least one widget, which is a strong claim.",
        modality: "assertoric",
      },
    ],
    inferences: [
      {
        type: "inference",
        statement: "Gadgets require widgets.",
        quote: "It follows that you cannot build a gadget with no widgets.",
      },
    ],
    procedures: [
      {
        headword: "Assemble a gadget",
        steps: [
          {
            type: "procedure",
            statement: "Assemble the widgets in order.",
            quote: "First, assemble the widgets in order.",
          },
          {
            type: "procedure",
            statement: "Bolt them together into a gadget.",
            quote: "Then bolt them together into a gadget.",
          },
        ],
      },
    ],
    edges: [
      {
        fromHeadword: "Gadget",
        rel: "depends-on",
        to: "Widget",
        quote: "gadget depends on at least one widget",
      },
      // off-registry rel → dropped before locate
      { fromHeadword: "Gadget", rel: "causes", to: "Widget", quote: "unused" },
      // no local unit for endpoint → dropped before locate
      { fromHeadword: "Gadget", rel: "part-of", to: "Missing", quote: "unused" },
    ],
    ...overrides,
  };
}

const payloadBlocks: Block[] = [{ id: "B9", text: "const answer = 42;" }];

test("locateGraph: frontmatter bytes/sha256 equal computeSource(path, body)", () => {
  const md = projectMarkdown(locateGraph(pre(), PATH, BODY, payloadBlocks));
  const src = computeSource(PATH, BODY);
  expect(md).toContain(`source: { path: ${src.path}, bytes: ${src.bytes}, sha256: ${src.sha256} }`);
});

test("locateGraph: the expected sections populate", () => {
  const md = projectMarkdown(locateGraph(pre(), PATH, BODY, payloadBlocks));
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

test("locateGraph: every emitted start..end anchor round-trips against the body bytes", () => {
  const md = projectMarkdown(locateGraph(pre(), PATH, BODY, payloadBlocks));
  const buf = Buffer.from(BODY, "utf8");
  const anchors = [...md.matchAll(/(\d+)\.\.(\d+)/g)];
  expect(anchors.length).toBeGreaterThan(0);
  for (const m of anchors) {
    const span: [number, number] = [Number(m[1]), Number(m[2])];
    const slice = sliceBytes(buf, span);
    expect(slice.length).toBeGreaterThan(0);
    expect(BODY).toContain(slice);
  }
});

test("locateGraph: a concept anchor round-trips to its verbatim quote", () => {
  const result = locateGraph(pre(), PATH, BODY, payloadBlocks);
  const widget = result.units.find((u) => u.id === "Widget")!;
  expect(sliceBytes(Buffer.from(BODY, "utf8"), widget.span)).toBe(
    "A widget is a small composable unit of work.",
  );
});

test("locateGraph: procedure id is the group headword; statement joins the steps", () => {
  const result = locateGraph(pre(), PATH, BODY, payloadBlocks);
  const proc = result.units.find((u) => u.type === "procedure")!;
  expect(proc.id).toBe("Assemble a gadget");
  expect(proc.statement).toBe("Assemble the widgets in order.\nBolt them together into a gadget.");
});

test("locateGraph: judgement ids are ordinal (J1..), inference ids ordinal (I1..)", () => {
  const result = locateGraph(pre(), PATH, BODY, payloadBlocks);
  expect(result.units.find((u) => u.type === "judgment")!.id).toBe("J1");
  expect(result.units.find((u) => u.type === "inference")!.id).toBe("I1");
});

test("locateGraph: the payload retain lane folds in (statement IS the verbatim block)", () => {
  const result = locateGraph(pre(), PATH, BODY, payloadBlocks);
  const payload = result.units.find((u) => u.type === "payload")!;
  expect(payload.statement).toBe("const answer = 42;");
  expect(sliceBytes(Buffer.from(BODY, "utf8"), payload.span)).toBe("const answer = 42;");
});

test("locateGraph: with no payloadBlocks, no payload unit is emitted", () => {
  const result = locateGraph(pre(), PATH, BODY);
  expect(result.units.some((u) => u.type === "payload")).toBe(false);
});

test("locateGraph: Relations render `from — rel → to`", () => {
  const md = projectMarkdown(locateGraph(pre(), PATH, BODY, payloadBlocks));
  expect(md).toContain("gadget — depends-on → widget");
});

test("locateGraph: an off-registry rel and a no-unit endpoint are dropped (one edge survives)", () => {
  const result = locateGraph(pre(), PATH, BODY, payloadBlocks);
  expect(result.edges).toHaveLength(1);
  const md = projectMarkdown(result);
  const relationLines = md.split("\n").filter((l) => l.includes("→"));
  expect(relationLines).toHaveLength(1);
});

test("locateGraph: title/abstract ride on the returned projection", () => {
  const result = locateGraph(pre(), PATH, BODY, payloadBlocks);
  expect(result.title).toBe("Widgets and gadgets");
  expect(result.abstract).toBe("Widgets compose into gadgets.");
});

test("locateGraph: a quote absent from body hard-aborts with LocateError", () => {
  const badPre = pre({
    concepts: [
      {
        type: "concept",
        id: "Ghost",
        statement: "raw",
        quote: "this exact sentence is not present in the body",
      },
    ],
    edges: [],
  });
  expect(() => locateGraph(badPre, PATH, BODY)).toThrow(LocateError);
});
