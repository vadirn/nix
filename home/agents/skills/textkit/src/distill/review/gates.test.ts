// gates.test.ts — the evidence-forced citation floor on runFidelityBackstop (Backlog 23).
//
// A "translated" verdict is normally skipped (it produces no residue). These tests pin the
// downgrade: a translated grade survives ONLY when the judge's cited `evidence` is a literal
// (gently-normalized) span of the unit's SOURCE block; an uncited (empty) or fabricated citation
// is coerced to an "inconclusive" residue and surfaced for review, so a cheap unjustified pass can
// no longer launder invention past the sole anti-hallucination floor. Mirrored for concepts AND
// procedures — procedures are half the sole-floor surface. The judge call is stubbed by dependency
// injection (the `ask` seam), never a process-global module mock (see degradation.test.ts).
import { expect, test } from "bun:test";
import { type Span } from "textkit/distill/mdstruct.ts";
import { type Projection } from "textkit/distill/graph/project.ts";
import { type ConceptVerdict, type StepVerdict } from "textkit/distill/prompt/prompts.ts";
import { runFidelityBackstop } from "textkit/distill/review/gates.ts";
import { askJson } from "@skills/llm/llm.ts";

// One source note carrying one concept sentence and one procedure sentence. ASCII, so byte offsets
// equal char offsets and the spans below are plain indexOf ranges.
const SRC = "A widget is a small reusable gadget. First unplug the device, then wait ten seconds.";
const C_TEXT = "A widget is a small reusable gadget.";
const P_TEXT = "First unplug the device, then wait ten seconds.";
const span = (text: string): Span => {
  const start = SRC.indexOf(text);
  return [start, start + Buffer.byteLength(text)];
};

const RESULT: Projection = {
  source: { path: "note.md", bytes: Buffer.byteLength(SRC), sha256: "deadbeef" },
  units: [
    { id: "widget", type: "concept", statement: C_TEXT, span: span(C_TEXT) },
    {
      id: "Reset",
      type: "procedure",
      statement: "Unplug the device\nWait ten seconds",
      span: span(P_TEXT),
    },
  ],
  edges: [],
};

// A judge stub: returns the given concept + group verdicts, dispatched on the prompt marker the
// workflow gate adds ("for a procedure checklist"). Both gate prompts contain "independent fidelity
// judge", so the procedure marker must be checked first.
function judge(concept: ConceptVerdict, group: StepVerdict): typeof askJson {
  return (async (_model: unknown, prompt: string) => {
    if (prompt.includes("for a procedure checklist")) return { groups: [group] };
    return { thesisRecoverable: true, concepts: [concept] };
  }) as typeof askJson;
}

const run = (concept: ConceptVerdict, group: StepVerdict) =>
  runFidelityBackstop("thesis", RESULT, "OUTPUT BODY", SRC, "en", judge(concept, group));

// baseline citation-backed verdicts, reused as the "stays skipped" partner when a test downgrades
// only the other lane.
const backedConcept: ConceptVerdict = {
  term: "widget",
  grade: "translated",
  evidence: "a small reusable gadget",
  missing: "",
};
const backedGroup: StepVerdict = {
  id: "Reset",
  grade: "translated",
  evidence: "unplug the device",
  missing: "",
};

test("citation-backed translated verdicts stay skipped (no residue) — both lanes", async () => {
  const { residue, gateSkipped } = await run(backedConcept, backedGroup);
  expect(residue).toHaveLength(0);
  expect(gateSkipped).toBe(0);
});

test("concept: empty evidence downgrades a translated verdict to an inconclusive residue", async () => {
  const { residue, gateSkipped } = await run(
    { term: "widget", grade: "translated", evidence: "", missing: "" },
    backedGroup, // procedure stays skipped
  );
  expect(residue).toHaveLength(1);
  expect(residue[0]!.label).toBe("widget");
  expect(residue[0]!.kind).toBe("def");
  expect(residue[0]!.reasonClass).toBe("gate-inconclusive");
  expect(residue[0]!.reason).toContain("empty evidence");
  // integrity ≠ entailment: surfaced because the citation is unverifiable, not because disproved
  expect(residue[0]!.reason).toContain("citation integrity, not entailment");
  expect(gateSkipped).toBe(1); // the downgrade is counted as surfaced-but-unverified
});

test("concept: evidence absent from source downgrades a translated verdict", async () => {
  const { residue, gateSkipped } = await run(
    { term: "widget", grade: "translated", evidence: "a large disposable widget", missing: "" },
    backedGroup,
  );
  expect(residue).toHaveLength(1);
  expect(residue[0]!.kind).toBe("def");
  expect(residue[0]!.reasonClass).toBe("gate-inconclusive");
  expect(residue[0]!.reason).toContain("absent from source");
  expect(gateSkipped).toBe(1);
});

test("procedure: empty evidence downgrades a translated group verdict to an inconclusive residue", async () => {
  const { residue, gateSkipped } = await run(
    backedConcept, // concept stays skipped
    { id: "Reset", grade: "translated", evidence: "", missing: "" },
  );
  expect(residue).toHaveLength(1);
  expect(residue[0]!.label).toBe("Reset");
  expect(residue[0]!.kind).toBe("steps");
  expect(residue[0]!.reasonClass).toBe("gate-inconclusive");
  expect(residue[0]!.reason).toContain("citation integrity, not entailment");
  expect(residue[0]!.stepIdxs).toEqual([]);
  expect(gateSkipped).toBe(1);
});

test("procedure: evidence absent from source downgrades a translated group verdict", async () => {
  const { residue, gateSkipped } = await run(backedConcept, {
    id: "Reset",
    grade: "translated",
    evidence: "reboot into safe mode",
    missing: "",
  });
  expect(residue).toHaveLength(1);
  expect(residue[0]!.kind).toBe("steps");
  expect(residue[0]!.reason).toContain("absent from source");
  expect(gateSkipped).toBe(1);
});

test("both lanes downgrade together and gateSkipped counts each", async () => {
  const { residue, gateSkipped } = await run(
    { term: "widget", grade: "translated", evidence: "", missing: "" },
    { id: "Reset", grade: "translated", evidence: "nonexistent directive", missing: "" },
  );
  expect(residue).toHaveLength(2);
  expect(residue.map((r) => r.kind).sort()).toEqual(["def", "steps"]);
  expect(gateSkipped).toBe(2);
});
