// locate-graph.test.ts — the locate stage (locate-graph.ts) without a live model: a fixture body +
// a hand-built PreGraph → locateGraph → projectMarkdown. Asserts the frontmatter Source, that the
// expected sections populate, that every emitted start..end anchor round-trips against the body
// bytes, that Relations render `from — rel → to`, and that the payload retain lane folds in.
// Idea-lane spans are BLOCK-GRANULAR (the enclosing mdstruct block snapQuote resolves to, not the
// quote's exact byte extent), so a concept/step/edge anchor round-trips to its whole enclosing
// paragraph; the payload lane alone stays byte-exact (it rides `locate`). Negative: a garbage quote
// sharing no token with any block hard-aborts (SnapError); a no-unit endpoint is dropped, while an
// off-registry rel (open registry) is KEPT and rendered. Converges on the e2e.test.ts
// template (build the graph directly). Run with
// `bun test locate-graph.test.ts` — parseDoc (the default `targets`) spawns the `mdstruct` binary,
// which must be on PATH.
import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { computeSource, type PreGraph } from "@/distill/graph/graph.ts";
import { locateGraph } from "@/distill/extract/locate-graph.ts";
import { SnapError } from "@/distill/extract/snap.ts";
import { sliceBytes } from "@/distill/mdstruct.ts";
import { projectMarkdown } from "@/distill/graph/project.ts";
import type { Block } from "@/core/text.ts";

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
      // off-registry rel (open registry) → KEPT, located like any other edge
      { fromHeadword: "Gadget", rel: "causes", to: "Widget", quote: "which is a strong claim" },
      // no local unit for endpoint → dropped before locate (quote is never located, so it can
      // stay a placeholder)
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

test("locateGraph: a concept anchor snaps to its enclosing block (block-granular, not the exact quote)", () => {
  const result = locateGraph(pre(), PATH, BODY, payloadBlocks);
  const widget = result.units.find((u) => u.id === "Widget")!;
  // the quote is "A widget is a small composable unit of work."; snapQuote resolves it to the
  // enclosing paragraph block, which pairs both widget/gadget definition lines.
  expect(sliceBytes(Buffer.from(BODY, "utf8"), widget.span)).toBe(
    "A widget is a small composable unit of work.\nA gadget is a larger assembly built from widgets.",
  );
});

test("locateGraph: procedure id is the group headword; statement joins the steps", () => {
  const result = locateGraph(pre(), PATH, BODY, payloadBlocks);
  const proc = result.units.find((u) => u.type === "procedure")!;
  expect(proc.id).toBe("Assemble a gadget");
  expect(proc.statement).toBe("Assemble the widgets in order.\nBolt them together into a gadget.");
});

test("locateGraph: per-step spans — every non-lead procedure step is anchored by its own subSpan", () => {
  const result = locateGraph(pre(), PATH, BODY, payloadBlocks);
  const proc = result.units.find((u) => u.type === "procedure")!;
  // two steps → one tail subSpan, snapped from the second step's own quote to its enclosing block
  expect(proc.subSpans).toHaveLength(1);
  const buf = Buffer.from(BODY, "utf8");
  // "Then bolt them together into a gadget." snaps to the enclosing procedure paragraph (all three
  // step lines share one block) — block-granular, not the exact step line.
  expect(sliceBytes(buf, proc.subSpans![0]!)).toBe(
    "First, assemble the widgets in order.\nThen bolt them together into a gadget.\nFinally, verify the assembly is sound.",
  );
  // it renders as an anchored step 2 in the projection
  const md = projectMarkdown(result);
  expect(md).toMatch(/2\. Bolt them together into a gadget\.\s+\d+\.\.\d+/);
});

test("locateGraph: per-bullet spans — a concept's extension bullets locate to their own quotes", () => {
  const result = locateGraph(
    pre({
      concepts: [
        {
          type: "concept",
          id: "Widget",
          statement: "A widget is a small composable unit.",
          quote: "A widget is a small composable unit of work.",
          bullets: [
            {
              statement: "is the base assembly unit",
              quote: "A gadget is a larger assembly built from widgets.",
            },
          ],
        },
      ],
      edges: [],
    }),
    PATH,
    BODY,
    payloadBlocks,
  );
  const widget = result.units.find((u) => u.id === "Widget")!;
  expect(widget.statement).toBe("A widget is a small composable unit.\nis the base assembly unit");
  expect(widget.subSpans).toHaveLength(1);
  const buf = Buffer.from(BODY, "utf8");
  // the bullet quote snaps to its enclosing paragraph block (block-granular), which carries both
  // the widget and gadget definition lines.
  expect(sliceBytes(buf, widget.subSpans![0]!)).toBe(
    "A widget is a small composable unit of work.\nA gadget is a larger assembly built from widgets.",
  );
});

test("locateGraph: a bullet with an empty quote yields a null hole (unanchored), not a hard abort", () => {
  const result = locateGraph(
    pre({
      concepts: [
        {
          type: "concept",
          id: "Widget",
          statement: "A widget is a small composable unit.",
          quote: "A widget is a small composable unit of work.",
          bullets: [{ statement: "a synthesized property", quote: "" }],
        },
      ],
      edges: [],
    }),
    PATH,
    BODY,
  );
  const widget = result.units.find((u) => u.id === "Widget")!;
  expect(widget.subSpans).toEqual([null]);
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

test("locateGraph: a no-unit endpoint is dropped; an off-registry rel is kept (two edges survive)", () => {
  const result = locateGraph(pre(), PATH, BODY, payloadBlocks);
  // depends-on/Widget and causes/Widget survive; part-of/Missing is dropped (no local unit)
  expect(result.edges).toHaveLength(2);
  const md = projectMarkdown(result);
  const relationLines = md.split("\n").filter((l) => l.includes("→"));
  expect(relationLines).toHaveLength(2);
});

test("locateGraph: an off-registry rel (e.g. a causal predicate) survives end-to-end and renders anchored in ## Relations", () => {
  const result = locateGraph(pre(), PATH, BODY, payloadBlocks);
  const causal = result.edges.find((e) => e.rel === "causes");
  expect(causal).toBeDefined();
  // the edge quote "which is a strong claim" snaps to its enclosing block (block-granular).
  expect(sliceBytes(Buffer.from(BODY, "utf8"), causal!.span)).toBe(
    "Every gadget depends on at least one widget, which is a strong claim.",
  );
  const md = projectMarkdown(result);
  expect(md).toContain("gadget — causes → widget");
  const causalLine = md.split("\n").find((l) => l.includes("causes"))!;
  expect(causalLine).toMatch(/\d+\.\.\d+$/); // rendered with its own trailing anchor
});

test("locateGraph: title/abstract ride on the returned projection", () => {
  const result = locateGraph(pre(), PATH, BODY, payloadBlocks);
  expect(result.title).toBe("Widgets and gadgets");
  expect(result.abstract).toBe("Widgets compose into gadgets.");
});

test("locateGraph: a head quote sharing no token with any block hard-aborts with SnapError", () => {
  const badPre = pre({
    concepts: [
      {
        type: "concept",
        id: "Ghost",
        statement: "raw",
        // garbage: shares no token with any block, so snapQuote scores 0 and throws (a near-miss
        // paraphrase would instead snap to its block — that is the point of the block-granular gate)
        quote: "zzz qqq xkcd florble",
      },
    ],
    edges: [],
  });
  expect(() => locateGraph(badPre, PATH, BODY)).toThrow(SnapError);
});
