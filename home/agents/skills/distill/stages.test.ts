// stage-level tests — run with `bun test` from this directory.
//
// 17e decomposed distill() into named stage functions behind the seams the 17a-d
// splits stabilized. This suite pins the three PURE stages directly (no model
// call): orderContent (grade→order), computeStepGroups (group by shared source),
// and buildFooter (the success-footer renderer). The async stages route through
// the network and are covered by the end-to-end + degradation suites.
import { expect, test } from "bun:test";
import type { Block, IR, Grade, WorkStep } from "./text.ts";
import { buildFooter, computeStepGroups, orderContent } from "./pipeline.ts";

// ---- orderContent: retain selection + note-order entries/steps ----
test("orderContent: orders entries by first source block, drops fully-retained steps", () => {
  const blocks: Block[] = [
    { id: "B1", text: "a" },
    { id: "B2", text: "b" },
    { id: "B3", text: "c" },
  ];
  const grades: Map<string, Grade> = new Map([
    ["B1", "distill"],
    ["B2", "retain"],
    ["B3", "distill"],
  ]);
  const ir: IR = {
    description: "",
    thesis: "t",
    glossary: [
      { term: "X", def: "dx", relations: [], source: ["B3"] }, // orderKey 2
      { term: "Y", def: "dy", relations: [], source: ["B1"] }, // orderKey 0
    ],
    workflow: [
      { step: "do z", source: ["B1"] }, // B1 is distill → kept
      { step: "do w", source: ["B2"] }, // every source block retained → dropped
    ],
  };
  const { retained, retainedIds, orderedEntries, orderedSteps } = orderContent(ir, blocks, grades);
  expect(retained).toEqual([{ id: "B2", text: "b" }]);
  expect([...retainedIds]).toEqual(["B2"]);
  expect(orderedEntries.map((e) => e.term)).toEqual(["Y", "X"]);
  expect(orderedSteps.map((s) => s.step)).toEqual(["do z"]);
});

// ---- computeStepGroups: steps sharing a source block group together ----
test("computeStepGroups: groups by shared source, ids in encounter order, joins source text", () => {
  const blockById = new Map<string, Block>([
    ["B1", { id: "B1", text: "block one" }],
    ["B2", { id: "B2", text: "block two" }],
  ]);
  const steps: WorkStep[] = [
    { step: "s1", source: ["B1"] },
    { step: "s2", source: ["B1"] },
    { step: "s3", source: ["B2"] },
  ];
  const groups = computeStepGroups(steps, blockById);
  expect(groups).toEqual([
    { id: "workflow:1", idxs: [0, 1], sourceText: "block one" },
    { id: "workflow:2", idxs: [2], sourceText: "block two" },
  ]);
});

// ---- buildFooter: tag composition + size-tag branches ----
test("buildFooter: compressed run renders size + steps tags, omits the zero tags", () => {
  expect(
    buildFooter({
      beforeWords: 100,
      afterWords: 60,
      entries: 3,
      steps: 2,
      verbatim: 1,
      residue: 0,
      gateSkipped: 0,
      keptVerbatim: 0,
      retries: 0,
      proseFixes: 0,
      coreOnly: false,
    }),
  ).toBe(
    "— distilled prose+gloss · 100→60 words (-40%) · 3 entries · 2 steps · 1 verbatim · 0 residue",
  );
});

test("buildFooter: ±0% on no shrink, --core-only shape, gate-skipped + retries tags", () => {
  expect(
    buildFooter({
      beforeWords: 50,
      afterWords: 50,
      entries: 2,
      steps: 0,
      verbatim: 0,
      residue: 1,
      gateSkipped: 1,
      keptVerbatim: 0,
      retries: 2,
      proseFixes: 0,
      coreOnly: true,
    }),
  ).toBe(
    "— distilled gloss · 50→50 words (±0%) · 2 entries · 0 verbatim · 1 residue · 1 gate-skipped · 2 retries",
  );
});
