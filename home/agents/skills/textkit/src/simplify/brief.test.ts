// simplify/brief tests — coerceBrief defends against a dropped or mistyped model key, and
// renderBrief lays out the eight sections, bullets empty lists as "None.", and fences the rewrite
// so an inner ``` run cannot close it early. Pure, offline.
import { expect, test } from "bun:test";
import { coerceBrief, renderBrief } from "textkit/simplify/brief.ts";
import type { GuardReport } from "textkit/simplify/guard.ts";

const cleanGuard: GuardReport = {
  masks: { ok: true, input: 2, output: 2 },
  code: { ok: true, source: 1, rewrite: 1 },
  names: { corrupted: [], invented: [] },
  wordcap: [],
  list: { ok: true, source: { ordered: 0, unordered: 0 }, rewrite: { ordered: 0, unordered: 0 } },
};

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
  const out = renderBrief(coerceBrief({ verdict: "v", rewrite: "body" }), cleanGuard);
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
  const out = renderBrief(coerceBrief({ verdict: "clean", rewrite: "x" }), cleanGuard);
  expect(out).toContain("## cut\n\nNone.");
  expect(out).toContain("## guard\n\nAll checks passed.");
});

test("renderBrief: the rewrite fence outruns an inner triple-backtick code block", () => {
  const rewrite = "Intro.\n\n```ts\nconst x = 1;\n```\n\nDone.";
  const out = renderBrief(coerceBrief({ rewrite }), cleanGuard);
  // the wrapper fence must be longer than the inner ``` so the block stays whole
  expect(out).toContain("````markdown\n" + rewrite + "\n````");
});
