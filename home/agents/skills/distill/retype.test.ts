// retype.test.ts — the span-typing review (retype.ts). Converges on
// the e2e.test.ts / project.test.ts template: a hand-built DistillationResult (real located spans) +
// a body, driven through buildTypingReview / applyTyping / projectMarkdown — no live model, no TTY.
// Covers: (1) the round-trip law parseInteract(renderBlock(spec)) ≡ spec for the pick-one-per-unit +
// confirm-all shape, including the slice payload and a CRLF-source slice that must LF-normalize;
// (2) the `type` apply verb sets unit.type and projectMarkdown re-buckets, ids + edges surviving;
// (3) the skip/decline invariant — no review leaves the projection byte-identical; (4) the gate —
// an unchecked confirm-all and an unresolved pick-one both refuse, graph untouched. The full-pipeline
// non-TTY skip (distill()'s TTY gate) is additionally pinned by every existing suite staying green.
// Run with `bun test retype.test.ts` from this directory.
import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { computeSource, type DistillationResult, type Edge, type Unit } from "./graph.ts";
import { locate } from "./locate.ts";
import { projectMarkdown, type Projection } from "./project.ts";
import { type Block, type BlockSpec, parseInteract, renderBlock } from "./interact.ts";
import { applyTyping, buildTypingReview, typingBlockId } from "./retype.ts";

const PATH = "widgets.md";
const BODY = [
  "# Widgets and gadgets", // 0
  "", // 1
  "A widget is a small composable unit of work.", // 2
  "A gadget is a larger assembly built from widgets.", // 3
  "", // 4
  "Every gadget depends on at least one widget, which is a strong claim.", // 5
  "", // 6
  "First, assemble the widgets in order.", // 7
  "", // 8
  "const answer = 42;", // 9
].join("\n");

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
    unit(
      "J1",
      "judgment",
      "Gadgets depend on widgets.",
      "Every gadget depends on at least one widget, which is a strong claim.",
    ),
    unit(
      "Assemble a gadget",
      "procedure",
      "Assemble the widgets in order.",
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

// Parse a single-block document and assert it is clean; return the one block (mirrors interact.test).
function parseOne(text: string): Block {
  const { blocks, errors } = parseInteract(text);
  expect(errors).toEqual([]);
  expect(blocks).toHaveLength(1);
  return blocks[0]!;
}

// A parsed Block back to a BlockSpec, for the round-trip equality (mirrors interact.test.ts::toSpec).
const toSpec = (b: Block): BlockSpec => ({
  kind: b.kind,
  id: b.id,
  src: b.src,
  dest: b.dest,
  intro: b.intro,
  items: b.items.map((i) => ({
    state: i.state,
    verb: i.verb,
    target: i.target,
    note: i.note,
    payload: i.payload,
  })),
});

// ---- 1. round-trip law ----

test("round-trip: every buildTypingReview block satisfies parseInteract(renderBlock(spec)) ≡ spec", () => {
  const specs = buildTypingReview(result(), BODY);
  // one pick-one per unit + one trailing confirm-all gate
  expect(specs).toHaveLength(6);
  expect(specs.slice(0, 5).every((s) => s.kind === "pick-one")).toBe(true);
  expect(specs[5]!.kind).toBe("confirm-all");
  for (const spec of specs) {
    expect(toSpec(parseOne(renderBlock(spec)))).toEqual(spec);
  }
});

test("round-trip: each pick-one carries exactly one checked (standing) item and the slice rides on it", () => {
  const r = result();
  const specs = buildTypingReview(r, BODY);
  specs.slice(0, 5).forEach((spec, i) => {
    const checked = spec.items.filter((it) => it.state === "checked");
    expect(checked).toHaveLength(1);
    expect(checked[0]!.target).toBe(r.units[i]!.type); // standing type pre-checked
    expect(checked[0]!.payload).toBeDefined(); // the resolved slice rides on the standing item
    // the other four options are unchecked and carry NO payload (not duplicated across five)
    expect(
      spec.items.filter((it) => it.state === "unchecked").every((it) => it.payload === undefined),
    ).toBe(true);
    // the five options are exactly the five UnitType slugs
    expect(spec.items.map((it) => it.target)).toEqual([
      "concept",
      "judgment",
      "inference",
      "procedure",
      "payload",
    ]);
    expect(spec.items.every((it) => it.verb === "type")).toBe(true);
  });
  // the gate verb is `reviewed`
  expect(specs[5]!.items[0]!.verb).toBe("reviewed");
});

test("round-trip: a CRLF-source slice LF-normalizes and still round-trips", () => {
  const crlfBody = "line one\r\nline two\r\n";
  const r: DistillationResult = {
    source: computeSource("crlf.md", crlfBody),
    units: [{ id: "P", type: "payload", statement: "line one\nline two", span: [0, 18] }],
    edges: [],
  };
  const [spec] = buildTypingReview(r, crlfBody);
  const checked = spec!.items.find((it) => it.state === "checked")!;
  // sliceBytes over [0,18] is "line one\r\nline two"; the display payload is LF-normalized
  expect(checked.payload).toBe("line one\nline two");
  expect(checked.payload).not.toContain("\r");
  // renderBlock rejects \r in a payload — that it does not throw proves the normalization, and the
  // block round-trips
  expect(toSpec(parseOne(renderBlock(spec!)))).toEqual(spec!);
});

// ---- 2. the `type` apply verb: re-typing sets unit.type; the projector re-buckets ----

// Render buildTypingReview's specs after mutating item states (the reviewer's editor edit, modeled by
// flipping states on the specs and re-rendering — a faithful edited document).
function renderEdited(specs: BlockSpec[]): string {
  return specs.map(renderBlock).join("");
}
function checkGate(specs: BlockSpec[]): BlockSpec[] {
  return specs.map((s) =>
    s.kind === "confirm-all"
      ? { ...s, items: s.items.map((it) => ({ ...it, state: "checked" as const })) }
      : s,
  );
}
function retypeBlock(specs: BlockSpec[], idx: number, to: string): BlockSpec[] {
  return specs.map((s, i) =>
    i === idx
      ? {
          ...s,
          items: s.items.map((it) => ({
            ...it,
            state: (it.target === to ? "checked" : "unchecked") as const,
          })),
        }
      : s,
  );
}

test("apply: re-typing a concept to judgment sets unit.type; projectMarkdown moves the section", () => {
  const r = result();
  const before = projectMarkdown(r);
  expect(before).toContain("### Widget"); // starts as a concept subsection
  const specs = buildTypingReview(r, BODY);
  // reviewer flips block 0 (Widget) concept → judgment, then checks the gate
  const edited = renderEdited(checkGate(retypeBlock(specs, 0, "judgment")));
  applyTyping(r, edited);
  expect(r.units[0]!.type).toBe("judgment"); // the FIELD is set — the unit did not move arrays
  expect(r.units[0]!.id).toBe("Widget"); // id preserved across the re-type
  const after = projectMarkdown(r);
  // Widget left ## Concepts and entered ## Judgements as a bare bullet; ## Concepts keeps Gadget
  expect(after).not.toContain("### Widget");
  expect(after).toContain("## Judgements");
  expect(after).toContain("- A widget is a small composable unit.");
  expect(after).toContain("### Gadget");
  // the edge Gadget → Widget still resolves (ids survive the re-type) — projectMarkdown throws if not
  expect(after).toContain("gadget — depends-on → widget");
});

test("apply: block ids map to units, and a confirm-only run (nothing re-typed) leaves types intact", () => {
  const r = result();
  const specs = buildTypingReview(r, BODY);
  // block id scheme: slug of the handle + array index
  expect(specs[0]!.id).toBe(typingBlockId(r.units[0]!, 0));
  expect(specs[0]!.id).toBe("widget-0");
  // reviewer checks only the gate, re-types nothing (every pick-one keeps its standing pre-check)
  const edited = renderEdited(checkGate(specs));
  applyTyping(r, edited);
  expect(r.units.map((u) => u.type)).toEqual([
    "concept",
    "concept",
    "judgment",
    "procedure",
    "payload",
  ]);
});

// ---- 3. skip / decline invariant ----

test("skip: a declined typing review leaves the projection byte-identical to no review", async () => {
  // runTypingReview is TTY-gated in distill(); a non-TTY run never invokes it, so the graph keeps its
  // extract-assigned types. Modeled here at the seam: a reviewer who declines (askFn → null) mutates
  // nothing, so projectMarkdown is byte-for-byte the pre-review projection.
  const { runTypingReview } = await import("./tty.ts");
  const r = result();
  const before = projectMarkdown(r);
  const confirmed = await runTypingReview(r, BODY, async () => null);
  expect(confirmed).toBe(false);
  expect(projectMarkdown(r)).toBe(before);
});

// ---- 4. gate ----

test("gate: an unchecked confirm-all refuses — applyTyping throws and the graph is untouched", () => {
  const r = result();
  const snapshot = r.units.map((u) => u.type);
  // default buildTypingReview leaves the gate UNCHECKED; every pick-one is valid (one checked)
  const doc = renderEdited(buildTypingReview(r, BODY));
  expect(() => applyTyping(r, doc)).toThrow(/gate/);
  expect(r.units.map((u) => u.type)).toEqual(snapshot); // no re-typing landed
});

test("gate: an unresolved pick-one (zero checked) refuses even with the gate checked", () => {
  const r = result();
  const snapshot = r.units.map((u) => u.type);
  // check the gate, then uncheck the standing item of block 0 without checking another → zero checked
  const specs = checkGate(buildTypingReview(r, BODY)).map((s, i) =>
    i === 0 ? { ...s, items: s.items.map((it) => ({ ...it, state: "unchecked" as const })) } : s,
  );
  expect(() => applyTyping(r, renderEdited(specs))).toThrow(/pick-one/);
  expect(r.units.map((u) => u.type)).toEqual(snapshot);
});

test("buildTypingReview: an empty graph yields no blocks", () => {
  const empty: DistillationResult = { source: computeSource("e.md", ""), units: [], edges: [] };
  expect(buildTypingReview(empty, "")).toEqual([]);
});
