// writing/verify tests — the deterministic verifier's accept/reject matrix on
// synthetic pairs. Pure, offline: no model call, no fixtures.
import { expect, test } from "bun:test";
import { verifySpellBlock } from "textkit/core/writing/verify.ts";

test("verifySpellBlock: identical input/output is ok", () => {
  expect(verifySpellBlock("a ⟦0⟧ b", "a ⟦0⟧ b")).toEqual({ ok: true });
});

test("verifySpellBlock: a dropped ⟦N⟧ token fails as mask tokens changed", () => {
  expect(verifySpellBlock("see ⟦0⟧ here", "see here")).toEqual({
    ok: false,
    reason: "mask tokens changed",
  });
});

test("verifySpellBlock: a duplicated ⟦N⟧ token fails as mask tokens changed", () => {
  expect(verifySpellBlock("see ⟦0⟧ here", "see ⟦0⟧ ⟦0⟧ here")).toEqual({
    ok: false,
    reason: "mask tokens changed",
  });
});

test("verifySpellBlock: a merged line fails as line structure changed", () => {
  expect(verifySpellBlock("first line\nsecond line", "first line second line")).toEqual({
    ok: false,
    reason: "line structure changed",
  });
});

test("verifySpellBlock: a 1-char fix in a 200-char block is ok", () => {
  const input = "The pipeline recieves each note from the inbox and does a quick triage. ".repeat(
    3,
  );
  expect(input.length).toBeGreaterThanOrEqual(200);
  expect(verifySpellBlock(input, input.replace("recieves", "receives"))).toEqual({ ok: true });
});

test("verifySpellBlock: a full rephrase fails as diff exceeds bound", () => {
  const input = "The pipeline recieves each note from the inbox and does a quick triage. ".repeat(
    3,
  );
  const rephrase = "Every note arriving in the inbox is triaged rapidly by our system. ".repeat(3);
  expect(verifySpellBlock(input, rephrase)).toEqual({ ok: false, reason: "diff exceeds bound" });
});

test("verifySpellBlock: a 1-word block correction rides the absolute floor of 4", () => {
  expect(verifySpellBlock("Teh", "The")).toEqual({ ok: true });
});

test("verifySpellBlock: a synonym swap inside the diff bound fails the word-distance check", () => {
  // observed live: "bruited" → "broadcast" (9-char edit in a 208-char block) sailed
  // under the 15% bound; a synonym is far from every input word, a spelling fix is not.
  const input =
    "Consider the enormity of what the old pipeline did: it bruited every failure to every subscriber, twice. Nobody was nonplussed. The fix comprises three parts, each smaller than the last. Which is the point.";
  expect(verifySpellBlock(input, input.replace("bruited", "broadcast"))).toEqual({
    ok: false,
    reason: "word replaced beyond spelling distance",
  });
});

test("verifySpellBlock: a real spelling fix stays within word distance (irregardless → regardless)", () => {
  const input = "A user reports lag; they are right, irregardless of what the dashboard says.";
  expect(verifySpellBlock(input, input.replace("irregardless", "regardless"))).toEqual({
    ok: true,
  });
});
