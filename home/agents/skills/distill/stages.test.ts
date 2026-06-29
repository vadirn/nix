// stage-level tests — run with `bun test` from this directory.
//
// 17e decomposed distill() into named stage functions behind the seams the 17a-d
// splits stabilized. This suite pins the three PURE stages directly (no model
// call): orderContent (grade→order), computeStepGroups (group by shared source),
// and buildFooter (the success-footer renderer). The async stages route through
// the network and are covered by the end-to-end + degradation suites.
import { expect, mock, test } from "bun:test";
import type { Block, IR, Grade, WorkStep } from "./text.ts";
import { buildFooter, computeStepGroups, orderContent, wikilinkResidue } from "./pipeline.ts";
import { extractCombo } from "./prompts.ts";

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
    noteRelations: [],
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

// ---- wikilinkResidue: dropped source edges surface; covered ones don't ----
test("wikilinkResidue: a dropped source wikilink surfaces; a relation/retained one does not", () => {
  const source =
    "prose [[30 notes/Elegant solution]] and [[20 cards/Outline speedrunning]].\n\n## References\n- [[30 notes/Kept link]]";
  // output: one link survived as a pre-slugged ## Relations endpoint, one verbatim in a
  // retained see-also list; the second prose link was dropped.
  const out =
    "## Relations\n\n- a subsumes:: [[30-notes-elegant-solution]]\n\n## References\n- [[30 notes/Kept link]]";
  const res = wikilinkResidue(source, out);
  expect(res.map((r) => r.term)).toEqual(["[[20 cards/Outline speedrunning]]"]);
  expect(res[0].reason).toMatch(/wikilink dropped/);
});

test("wikilinkResidue: a repeated dropped link is reported once", () => {
  expect(wikilinkResidue("[[a/B]] then [[a/B]] again", "no links")).toHaveLength(1);
});

test("wikilinkResidue: full coverage yields no residue", () => {
  expect(wikilinkResidue("[[x]] [[y]]", "[[x]] and [[y]]")).toEqual([]);
});

test("wikilinkResidue: a captured note-level edge counts as covered, not residue", () => {
  // the acceptance failure mode: two stated-relation hostless links were dropped to
  // residue. Once captured as a note-level edge in the ## Relations block (its to is a
  // pre-slugged [[file-slug]]), the slug matches the source and drops out of residue.
  const source =
    "Pragmatic first relates to [[Not all shipped work looks the same]] and [[Tech debt multiplied by AI]].";
  const out =
    "## Relations\n\n" +
    "- [[pragmatic-first-is-reconnaissance-for-elegance]] contrast-to:: [[not-all-shipped-work-looks-the-same]] (a)\n" +
    "- [[pragmatic-first-is-reconnaissance-for-elegance]] refines:: [[tech-debt-multiplied-by-ai]] (b)";
  expect(wikilinkResidue(source, out)).toEqual([]);
});

test("wikilinkResidue: slug-colliding source edges both surface even when output covers one", () => {
  // [[foo bar]] and [[foo/bar]] both slug to foo-bar; output covers the slug once.
  // Slug coverage cannot be attributed to a single edge, so both surface as residue
  // (loud false positive) rather than the dropped one passing silently.
  const res = wikilinkResidue("[[foo bar]] and [[foo/bar]]", "see [[foo bar]]");
  expect(res.map((r) => r.term).sort()).toEqual(["[[foo bar]]", "[[foo/bar]]"]);
  expect(res[0].reason).toMatch(/slug-collision/);
});

// ---- extractCombo: the note-level lane CODE gate (deterministic, model-independent) ----
// The lane is gated at BOTH the prompt and the code. This pins the code gate: even
// when the model emits a WELL-FORMED noteRelation (quoted predicate present, so the
// null-predicate backstop would otherwise keep it), extractCombo drops it to [] when
// the lane is off, and keeps it when on — proving the drop is the lane gate, not the
// backstop. fetch is mocked so the real transport runs without a network call.
const IR_WITH_NOTE_REL = {
  description: "d",
  thesis: "t",
  glossary: [],
  workflow: [],
  noteRelations: [
    { rel: "refines", to: "[[Tech debt multiplied by AI]]", predicate: "the same dynamic" },
  ],
};

function mockFetchIR(ir: unknown): typeof fetch {
  const m = mock(
    async () =>
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: JSON.stringify(ir) } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  );
  return m as unknown as typeof fetch;
}

test("extractCombo: lane OFF drops an emitted noteRelation despite a valid predicate", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockFetchIR(IR_WITH_NOTE_REL);
  try {
    const ir = await extractCombo(
      [{ id: "B1", text: "x" }],
      "",
      "en",
      { wikilinks: [], external: [] },
      "self",
      false,
    );
    expect(ir.noteRelations).toEqual([]); // the code gate drops the model's output
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("extractCombo: lane ON keeps a noteRelation carrying a quoted predicate", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockFetchIR(IR_WITH_NOTE_REL);
  try {
    const ir = await extractCombo(
      [{ id: "B1", text: "x" }],
      "",
      "en",
      { wikilinks: [], external: [] },
      "self",
      true,
    );
    expect(ir.noteRelations).toEqual([
      { rel: "refines", to: "[[Tech debt multiplied by AI]]", predicate: "the same dynamic" },
    ]);
  } finally {
    globalThis.fetch = realFetch;
  }
});
