// triage red corpus — run with `bun test` from this directory.
//
// Freezes Phase 3's serialization contract (build plan §5/§6) ahead of the
// implementation. Pins: buildIntermediary reproducing fixtures/interact-triage-emit.md
// BYTE-EXACT (the stamp src= is injectable, so the fixture's illustrative hash is
// passed literally); the reason-class → verb mapping (gate-inconclusive → keep,
// everything else → recover); positional workflow targets built from stepIdxs, not
// the pipeline-internal group id; the mandatory trailing confirm-all gate
// (id=triage-final, dest=/src= stamp) on residue-free runs too; epistemic_status
// FORCED to in-review; and renderability of hostile residue labels (multiline,
// backticked) — the fenced payload carries the verbatim truth, the target is only
// a handle.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "bun:test";
import { parseInteract, renderBlock, stripInteract } from "./interact.ts";
import type { Residue } from "./pipeline.ts";
import { TRIAGE_VERBS, buildIntermediary, residueToBlocks } from "./triage.ts";

const FIXTURE = readFileSync(
  resolve(import.meta.dir, "fixtures", "interact-triage-emit.md"),
  "utf8",
);

// The three residue entries the fixture serializes, exactly as the pipeline's
// push sites would shape them (pipeline.ts runFidelityGate): a failed def, a
// failed workflow group (stepIdxs 0-based into the emitted ## Workflow list; the
// group label is pipeline-internal and must NOT become the target), and a
// gate-inconclusive def that shipped in the body above.
const FIXTURE_RESIDUE: Residue[] = [
  {
    kind: "def",
    reasonClass: "failed",
    label: "Impression distance",
    reason: "inverted: def asserts nearness where source asserts a gap",
    source:
      "Impression distance is the gap between the felt sense of a scene and what\nthe eye verifies on re-inspection; the painting should honor the former.",
  },
  {
    kind: "steps",
    reasonClass: "failed",
    label: "workflow:1",
    stepIdxs: [1],
    reason: "workflow: drying precondition missing from steps",
    source:
      "Before glazing, let the underlayer dry fully; a damp underlayer lifts and\nmuddies the glaze.",
  },
  {
    kind: "def",
    reasonClass: "gate-inconclusive",
    label: "Anchor image",
    reason: "gate-inconclusive: judge returned no verdict after retry",
    source: "The anchor image is the first felt impression, fixed before mixing begins.",
  },
];

test("TRIAGE_VERBS is exactly recover/keep/reviewed", () => {
  expect([...TRIAGE_VERBS]).toEqual(["recover", "keep", "reviewed"]);
});

// ---- buildIntermediary: the plan-§5 golden ----

test("buildIntermediary golden: byte-exact against fixtures/interact-triage-emit.md", () => {
  // the future note is the fixture minus its own blocks — strip is the inverse
  // of the serialization, so the golden also pins that inverse relation
  const note = stripInteract(FIXTURE);
  const out = buildIntermediary(note, FIXTURE_RESIDUE, {
    dest: "impression-distance.md",
    src: "sha256:3f9c2a1b8d4e",
  });
  expect(out).toBe(FIXTURE);
});

test("buildIntermediary: no-residue run emits the gate block only, gate item text switches", () => {
  const note = "---\ntype: note\n---\n\n# T\n\nBody prose.\n";
  const out = buildIntermediary(note, [], { dest: "t.md", src: "new" });
  expect(out).not.toContain("pick-any");
  expect(out).toContain("<!-- interact: confirm-all id=triage-final dest=t.md src=new -->");
  expect(out).toContain(
    "- [ ] reviewed: distilled result above is final — apply writes t.md and deletes this file",
  );
  const { blocks, errors } = parseInteract(out);
  expect(errors).toEqual([]);
  expect(blocks.map((b) => b.id)).toEqual(["triage-final"]);
});

test("buildIntermediary: gate block is LAST and carries the injected stamp verbatim", () => {
  const note = "---\ntype: note\n---\n\n# T\n\nBody prose.\n";
  const out = buildIntermediary(note, FIXTURE_RESIDUE, {
    dest: "t.md",
    src: "sha256:aaaabbbbcccc",
  });
  const { blocks, errors } = parseInteract(out);
  expect(errors).toEqual([]);
  expect(blocks.map((b) => b.id)).toEqual(["residue", "triage-final"]);
  const gate = blocks[1]!;
  expect(gate.kind).toBe("confirm-all");
  expect(gate.dest).toBe("t.md");
  expect(gate.src).toBe("sha256:aaaabbbbcccc");
  // ends with exactly one newline (no trailing blank line at EOF)
  expect(out).toMatch(/<!-- \/interact -->\n$/);
  expect(out).not.toMatch(/\n\n$/);
});

test("buildIntermediary: epistemic_status is FORCED to in-review (explicit value overridden; created when absent)", () => {
  const explicit = "---\ntype: note\nepistemic_status: certified\n---\n\n# T\n\nBody.\n";
  expect(buildIntermediary(explicit, [], { dest: "t.md", src: "new" })).toContain(
    "epistemic_status: in-review",
  );
  expect(buildIntermediary(explicit, [], { dest: "t.md", src: "new" })).not.toContain("certified");
  const bare = "# T\n\nBody.\n";
  const out = buildIntermediary(bare, [], { dest: "t.md", src: "new" });
  expect(out).toContain("epistemic_status: in-review");
  expect(out.startsWith("---\n")).toBe(true);
});

// ---- residueToBlocks: reason class → verb, kind → target ----

test("residueToBlocks: empty residue yields no blocks", () => {
  expect(residueToBlocks([])).toEqual([]);
});

test("residueToBlocks: one pick-any id=residue block, all items unchecked, notes carry the reason", () => {
  const [b, ...rest] = residueToBlocks(FIXTURE_RESIDUE);
  expect(rest).toEqual([]);
  expect(b!.kind).toBe("pick-any");
  expect(b!.id).toBe("residue");
  expect(typeof b!.intro).toBe("string");
  expect(b!.items.every((i) => i.state === "unchecked")).toBe(true);
  expect(b!.items.map((i) => i.note)).toEqual(FIXTURE_RESIDUE.map((r) => r.reason));
  expect(b!.items.map((i) => i.payload)).toEqual(FIXTURE_RESIDUE.map((r) => r.source));
});

test("residueToBlocks: gate-inconclusive → keep, everything else → recover", () => {
  const [b] = residueToBlocks(FIXTURE_RESIDUE);
  expect(b!.items.map((i) => i.verb)).toEqual(["recover", "recover", "keep"]);
});

test("residueToBlocks: def targets are the term with targetCode; steps targets are 1-based stepIdxs", () => {
  const [b] = residueToBlocks(FIXTURE_RESIDUE);
  expect(b!.items[0]!.target).toBe("Impression distance");
  expect(b!.items[0]!.targetCode).toBe(true);
  expect(b!.items[1]!.target).toBe("workflow:2");
  expect(b!.items[1]!.targetCode).toBeFalsy();
});

test("residueToBlocks: a multi-step group joins its 1-based indices with commas", () => {
  const [b] = residueToBlocks([
    {
      kind: "steps",
      reasonClass: "gate-inconclusive",
      label: "workflow:3",
      stepIdxs: [1, 2],
      reason: "gate-inconclusive: judge returned no verdict",
      source: "Do the thing.",
    },
  ]);
  expect(b!.items[0]!.verb).toBe("keep");
  expect(b!.items[0]!.target).toBe("workflow:2,3");
});

test("residueToBlocks: thesis targets the literal 'thesis'", () => {
  const [b] = residueToBlocks([
    {
      kind: "thesis",
      reasonClass: "failed",
      label: "(thesis)",
      reason: "thesis not recoverable from output",
      source: "The thesis sentence.",
    },
  ]);
  expect(b!.items[0]!.verb).toBe("recover");
  expect(b!.items[0]!.target).toBe("thesis");
});

test("residueToBlocks: hostile edge/payload labels still render — single-line, backtick-free handles", () => {
  const hostile: Residue[] = [
    {
      kind: "payload",
      reasonClass: "dropped",
      label: "```bash\nrm -rf build\n```",
      reason: "fenced-block dropped: verbatim code/output block absent from output (not retained)",
      source: "```bash\nrm -rf build\n```",
    },
    {
      kind: "edge",
      reasonClass: "dropped",
      label: "[[impression distance]]",
      reason: "wikilink dropped: source edge absent from output (no relation, no retained block)",
      source: "[[impression distance]]",
    },
    {
      kind: "prose",
      reasonClass: "prose-inconclusive",
      label: "P2",
      reason: "prose-inconclusive: judge returned no verdict for this item's batch",
      source: "- the caveat line",
    },
  ];
  const [b] = residueToBlocks(hostile);
  for (const it of b!.items) {
    expect(it.verb).toBe("recover"); // dropped and prose-inconclusive both triage as recover
    expect(it.target).not.toContain("\n");
    expect(it.target).not.toContain("`");
    expect(it.target.length).toBeGreaterThan(0);
  }
  // the real guarantee: renderBlock accepts the block (its domain guards throw on
  // newline/backtick targets) and the payloads survive verbatim behind escalated fences
  const rendered = renderBlock(b!);
  const { blocks, errors } = parseInteract(rendered);
  expect(errors).toEqual([]);
  expect(blocks[0]!.items.map((i) => i.payload)).toEqual(hostile.map((r) => r.source));
});

test("residueToBlocks: a CRLF source renders (payload LF-normalized) instead of tripping renderBlock's CR guard", () => {
  // renderBlock throws on any \r in a payload or note; a CRLF source note threads
  // CRs into residue verbatim, and an emit-time throw would land AFTER the whole
  // LLM run as an uncaught crash. Pins the triage-side normalization.
  const [b] = residueToBlocks([
    {
      kind: "def",
      reasonClass: "failed",
      label: "X",
      reason: "line one\r\nline two",
      source: "payload line one\r\npayload line two",
    },
  ]);
  expect(b!.items[0]!.note).toBe("line one line two");
  expect(b!.items[0]!.payload).toBe("payload line one\npayload line two");
  const rendered = renderBlock(b!); // must not throw
  const { blocks, errors } = parseInteract(rendered);
  expect(errors).toEqual([]);
  expect(blocks[0]!.items[0]!.payload).toBe("payload line one\npayload line two");
});

test("residueToBlocks: a def term carrying a backtick degrades to a safe handle instead of tripping renderBlock's target guard", () => {
  // terms are LLM-extracted and unsanitized; renderBlock throws on backtick-in-target.
  // The degraded handle stays a grep-handle — the fenced payload carries the truth.
  const [b] = residueToBlocks([
    {
      kind: "def",
      reasonClass: "failed",
      label: "`tau` threshold",
      reason: "r: m",
      source: "The tau threshold bounds the route split.",
    },
  ]);
  expect(b!.items[0]!.target).not.toContain("`");
  expect(b!.items[0]!.target).toContain("tau threshold");
  const rendered = renderBlock(b!); // must not throw
  const { errors } = parseInteract(rendered);
  expect(errors).toEqual([]);
});

test("residueToBlocks: reason newlines are flattened to spaces in the item note", () => {
  const [b] = residueToBlocks([
    {
      kind: "def",
      reasonClass: "failed",
      label: "X",
      reason: "line one\nline two",
      source: "src",
    },
  ]);
  expect(b!.items[0]!.note).toBe("line one line two");
});

test("residueToBlocks: an empty source yields no payload fence", () => {
  const [b] = residueToBlocks([
    { kind: "def", reasonClass: "failed", label: "X", reason: "r: m", source: "" },
  ]);
  expect(b!.items[0]!.payload).toBeUndefined();
});
