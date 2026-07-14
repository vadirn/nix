// e2e.test.ts — end-to-end of the canonical PROJECTION without a live model: a fixture body + a
// hand-built DistillationResult (units/edges with real located spans) → projectMarkdown. This is
// the template the other rebuilt suites converge on — it builds the graph DIRECTLY (no Combo
// bridge, no settle chain), so it exercises projectMarkdown over a valid seven-section graph.
// Asserts the frontmatter Source, that every expected section populates, that every emitted
// start..end anchor round-trips against the body bytes, a specific concept anchor, and that
// Relations render `from — rel → to`. Span-locating and edge-filtering are covered by
// locate-graph.test.ts (the stage that computes them); here the graph is pre-built. Run with
// `bun test e2e.test.ts`.
import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { computeSource, type Edge, type Unit } from "@/graph/graph.ts";
import { locate } from "@/extract/locate.ts";
import { sliceBytes } from "@/kernel/mdstruct.ts";
import { projectMarkdown, type Projection } from "@/graph/project.ts";

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

// A unit whose span is located from a verbatim body quote, so every emitted anchor round-trips.
function unit(id: string, type: Unit["type"], statement: string, quote: string): Unit {
  return { id, type, statement, span: locate(BODY, quote) };
}

function result(): Projection {
  const units: Unit[] = [
    unit(
      "Widget",
      "concept",
      "A widget is a small composable unit.",
      "A widget is a small composable unit of work.",
    ),
    unit(
      "Gadget",
      "concept",
      "A gadget is an assembly of widgets.",
      "A gadget is a larger assembly built from widgets.",
    ),
    {
      ...unit(
        "J1",
        "judgment",
        "Gadgets are reliable.",
        "Every gadget depends on at least one widget, which is a strong claim.",
      ),
      modality: "assertoric",
    },
    unit(
      "I1",
      "inference",
      "Gadgets require widgets.",
      "It follows that you cannot build a gadget with no widgets.",
    ),
    unit(
      "Assemble a gadget",
      "procedure",
      "Assemble the widgets in order.\nBolt them together into a gadget.",
      "First, assemble the widgets in order.",
    ),
    unit("const answer = 42;", "payload", "const answer = 42;", "const answer = 42;"),
  ];
  const edges: Edge[] = [
    {
      from: "Gadget",
      to: "Widget",
      rel: "depends-on",
      span: locate(BODY, "gadget depends on at least one widget"),
    },
  ];
  return {
    source: computeSource(PATH, BODY),
    units,
    edges,
    title: "Widgets and gadgets",
    abstract: "Widgets compose into gadgets.",
  };
}

test("e2e: frontmatter bytes/sha256 equal computeSource(path, body)", () => {
  const md = projectMarkdown(result());
  const src = computeSource(PATH, BODY);
  expect(md).toContain(`source: { path: ${src.path}, bytes: ${src.bytes}, sha256: ${src.sha256} }`);
});

test("e2e: the expected sections populate", () => {
  const md = projectMarkdown(result());
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
  const md = projectMarkdown(result());
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
  const widget = result().units.find((u) => u.id === "Widget")!;
  expect(sliceBytes(Buffer.from(BODY, "utf8"), widget.span)).toBe(
    "A widget is a small composable unit of work.",
  );
});

test("e2e: Relations render `from — rel → to`", () => {
  const md = projectMarkdown(result());
  expect(md).toContain("gadget — depends-on → widget");
});

test("e2e: an edge whose endpoint references no unit is a hard failure", () => {
  const r = result();
  r.edges = [
    {
      from: "Gadget",
      to: "Missing",
      rel: "depends-on",
      span: locate(BODY, "gadget depends on at least one widget"),
    },
  ];
  expect(() => projectMarkdown(r)).toThrow();
});
