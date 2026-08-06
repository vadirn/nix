// simplify/brief tests — coerceBrief defends against a dropped or mistyped model key, and
// renderBrief lays out the eight sections, bullets empty lists as "None.", and fences the rewrite
// so an inner ``` run cannot close it early. Pure, offline.
import { expect, test } from "bun:test";
import { coerceBrief, renderBrief } from "textkit/simplify/brief.ts";
import type { GuardReport } from "textkit/simplify/guard.ts";
import type { MeaningReport } from "textkit/simplify/meaning.ts";

const cleanGuard: GuardReport = {
  masks: { ok: true, input: 2, output: 2 },
  code: { ok: true, source: 1, rewrite: 1 },
  names: { corrupted: [], invented: [] },
  wordcap: [],
  list: { ok: true, source: { ordered: 0, unordered: 0 }, rewrite: { ordered: 0, unordered: 0 } },
};

const cleanMeaning: MeaningReport = { checked: 0, findings: [], skipped: false };

test("coerceBrief: a full object round-trips; a change item keeps its before/after pair", () => {
  const raw = {
    verdict: "wordy",
    cut: ["in order to"],
    change: [{ before: "utilize", after: "use", transform: "plain-word", why: "plainer" }],
    shape: ["set → list"],
    keep: ["# heading"],
    borderline: ["kept the em dash"],
    rewrite: "Use it.",
  };
  expect(coerceBrief(raw)).toEqual(raw);
});

test("coerceBrief: dropped keys degrade to empty values, never a crash", () => {
  const b = coerceBrief({ verdict: "ok" });
  expect(b).toEqual({
    verdict: "ok",
    cut: [],
    change: [],
    shape: [],
    keep: [],
    borderline: [],
    rewrite: "",
  });
});

test("coerceBrief: mistyped fields are dropped — a string change item, a numeric verdict", () => {
  const b = coerceBrief({
    verdict: 42,
    cut: ["real", 7, null],
    change: ["not an object", { transform: "split" }, { before: "a", after: "b" }],
  });
  expect(b.verdict).toBe("");
  expect(b.cut).toEqual(["real"]); // non-strings filtered
  // "not an object" and the before/after-less item are dropped; the valid pair survives
  expect(b.change).toEqual([{ before: "a", after: "b", transform: "", why: "" }]);
});

test("renderBrief: the eight sections appear in order", () => {
  const out = renderBrief(coerceBrief({ verdict: "v", rewrite: "body" }), cleanGuard, cleanMeaning);
  const order = [
    "## verdict",
    "## cut",
    "## change",
    "## shape",
    "## keep",
    "## borderline",
    "## rewrite",
    "## guard",
  ];
  let last = -1;
  for (const h of order) {
    const at = out.indexOf(h);
    expect(at).toBeGreaterThan(last);
    last = at;
  }
});

test("renderBrief: empty diff sections read as 'None.', and a clean guard leads with the pass line", () => {
  const out = renderBrief(
    coerceBrief({ verdict: "clean", rewrite: "x" }),
    cleanGuard,
    cleanMeaning,
  );
  expect(out).toContain("## cut\n\nNone.");
  expect(out).toContain("## guard\n\nAll checks passed.");
  expect(out).toContain("- meaning: OK"); // the advisory meaning axis renders into the guard section
});

test("renderBrief: a skipped meaning axis still leads with the pass line and names the skip", () => {
  const skipped: MeaningReport = { checked: 2, findings: [], skipped: true };
  const out = renderBrief(coerceBrief({ verdict: "clean", rewrite: "x" }), cleanGuard, skipped);
  expect(out).toContain("## guard\n\nAll checks passed."); // a skip is clean, not a block
  expect(out).toContain("- meaning: skipped");
});

test("renderBrief: a meaning finding drops the pass line and names the shifted pair", () => {
  const flagged: MeaningReport = {
    checked: 1,
    findings: [
      {
        before: "The tool masks spans.",
        after: "Run the tool.",
        issue: "statement recast as a command",
      },
    ],
    skipped: false,
  };
  const out = renderBrief(coerceBrief({ verdict: "v", rewrite: "x" }), cleanGuard, flagged);
  expect(out).not.toContain("All checks passed.");
  expect(out).toContain("- meaning: 1 pair(s) shifted the speech act");
  expect(out).toContain("statement recast as a command");
});

test("renderBrief: the rewrite fence outruns an inner triple-backtick code block", () => {
  const rewrite = "Intro.\n\n```ts\nconst x = 1;\n```\n\nDone.";
  const out = renderBrief(coerceBrief({ rewrite }), cleanGuard, cleanMeaning);
  // the wrapper fence must be longer than the inner ``` so the block stays whole
  expect(out).toContain("````markdown\n" + rewrite + "\n````");
});
