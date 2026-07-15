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
import { type Span } from "@/distill/mdstruct.ts";
import { type Projection } from "@/distill/graph/project.ts";
import { type ConceptVerdict, type StepVerdict } from "@/distill/prompt/prompts.ts";
import { runFidelityBackstop } from "@/distill/review/gates.ts";
import { askJson } from "@/core/fw.ts";

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

// ---- the DISTILL_FIDELITY_ENSEMBLE leaf (Backlog 23) --------------------------------------------
// The ensemble flag is flipped by the trailing `ensemble` param, NOT by mutating process.env — the
// same per-call DI seam fidelityGate uses for defGate, so these run leak-free under bun's concurrent
// file execution. A per-call sequenced judge feeds each lane a queue of verdicts (one per run) and
// counts the calls, so the fan-out count and the any-invention fold are both pinned off a stub.

// A judge that returns the next verdict from a per-lane queue on each call (cycling if a lane fires
// more runs than it has queued verdicts) and counts calls + captures the temp it was handed. Lanes
// are dispatched on the procedure marker the workflow prompt adds.
function sequencedJudge(conceptSeq: ConceptVerdict[], groupSeq: StepVerdict[]) {
  let ci = 0;
  let gi = 0;
  const calls = { concept: 0, group: 0 };
  const temps: (number | undefined)[] = [];
  const ask = (async (
    _model: unknown,
    prompt: string,
    _mt: unknown,
    _call: unknown,
    temp?: number,
  ) => {
    temps.push(temp);
    if (prompt.includes("for a procedure checklist")) {
      const g = groupSeq[gi++ % groupSeq.length]!;
      calls.group++;
      return { groups: [g] };
    }
    const c = conceptSeq[ci++ % conceptSeq.length]!;
    calls.concept++;
    return { thesisRecoverable: true, concepts: [c] };
  }) as typeof askJson;
  return { ask, calls, temps };
}

const residueConcept: ConceptVerdict = {
  term: "widget",
  grade: "residue",
  direction: "output-invents",
  evidence: "a small reusable gadget",
  missing: "invented 'reusable'",
};

const runEnsemble = (ask: typeof askJson) =>
  runFidelityBackstop("thesis", RESULT, "OUTPUT BODY", SRC, "en", ask, true);
const runSingle = (ask: typeof askJson) =>
  runFidelityBackstop("thesis", RESULT, "OUTPUT BODY", SRC, "en", ask, false);

test("flag OFF: exactly one judge call per lane at temp 0 (undefined)", async () => {
  const j = sequencedJudge([backedConcept], [backedGroup]);
  const { residue, gateSkipped } = await runSingle(j.ask);
  expect(j.calls).toEqual({ concept: 1, group: 1 });
  expect(j.temps.every((t) => t === undefined)).toBe(true); // fw applies `?? 0` → hard temp 0
  expect(residue).toHaveLength(0);
  expect(gateSkipped).toBe(0);
});

test("flag ON: fans out to 3 calls per lane at ENSEMBLE_TEMP", async () => {
  const j = sequencedJudge([backedConcept], [backedGroup]);
  await runEnsemble(j.ask);
  expect(j.calls).toEqual({ concept: 3, group: 3 });
  expect(j.temps.every((t) => t === 0.4)).toBe(true);
});

test("flag ON fold: 3×translated-and-backed stays translated (no residue)", async () => {
  const j = sequencedJudge(
    [backedConcept, backedConcept, backedConcept],
    [backedGroup, backedGroup, backedGroup],
  );
  const { residue, gateSkipped } = await runEnsemble(j.ask);
  expect(residue).toHaveLength(0);
  expect(gateSkipped).toBe(0);
});

test("flag ON fold: one dissenting residue run wins the non-translated outcome", async () => {
  // two runs pass, the third flags residue → any-invention voting surfaces it as a failed residue.
  const j = sequencedJudge(
    [backedConcept, backedConcept, residueConcept],
    [backedGroup, backedGroup, backedGroup],
  );
  const { residue } = await runEnsemble(j.ask);
  const def = residue.find((r) => r.kind === "def");
  expect(def).toBeDefined();
  expect(def!.reasonClass).toBe("failed"); // a concrete residue finding, not an inconclusive flake
  expect(def!.reason).toContain("invented 'reusable'");
});

test("flag ON fold: unanimous 'translated' but one uncited run downgrades via the Step-3 floor", async () => {
  // all three grade translated, but the third cites a span absent from source — any-citation-fails
  // routes through the existing uncitedDowngrade unchanged, so it surfaces as gate-inconclusive.
  const j = sequencedJudge(
    [
      backedConcept,
      backedConcept,
      { term: "widget", grade: "translated", evidence: "a large disposable widget", missing: "" },
    ],
    [backedGroup, backedGroup, backedGroup],
  );
  const { residue, gateSkipped } = await runEnsemble(j.ask);
  const def = residue.find((r) => r.kind === "def");
  expect(def).toBeDefined();
  expect(def!.reasonClass).toBe("gate-inconclusive");
  expect(def!.reason).toContain("absent from source");
  expect(gateSkipped).toBe(1);
});
