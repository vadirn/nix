// simplify/guard tests — the four advisory axes on synthetic input/rewrite pairs: mask survival,
// fenced-code intactness, name corruption against source, and the word-cap scan. Plus guardClean
// and the formatGuard rendering. Pure, offline.
import { expect, test } from "bun:test";
import { type GuardInput, formatGuard, guardClean, runGuard } from "textkit/simplify/guard.ts";

// A clean baseline: masks survive (reordered but same multiset), the fenced block is byte-identical,
// no name drifts, every sentence is short. Individual tests override one field to break one axis.
const clean: GuardInput = {
  source: "We cite the Levenshtein distance. See the notes.",
  maskedInput: "We cite the ⟦0⟧ distance.\n\n```\ncode ⟦1⟧\n```\n\nShort line.",
  rewriteMasked: "The ⟦0⟧ distance, cited.\n\n```\ncode ⟦1⟧\n```\n\nShort line.",
  rewriteUnmasked: "The Levenshtein distance, cited. Short line.",
};

test("runGuard: a clean rewrite passes every axis", () => {
  const r = runGuard(clean);
  expect(r.masks.ok).toBe(true);
  expect(r.code.ok).toBe(true);
  expect(r.names.corrupted).toEqual([]);
  expect(r.names.invented).toEqual([]);
  expect(r.wordcap).toEqual([]);
  expect(guardClean(r)).toBe(true);
});

test("runGuard: a dropped ⟦N⟧ span fails the masks axis", () => {
  const r = runGuard({
    ...clean,
    rewriteMasked: "The ⟦0⟧ distance.\n\n```\ncode\n```\n\nShort line.",
  });
  expect(r.masks.ok).toBe(false);
  expect(guardClean(r)).toBe(false);
});

test("runGuard: a reworded fenced block fails the code axis", () => {
  const r = runGuard({
    ...clean,
    rewriteMasked: "The ⟦0⟧ distance.\n\n```\nCODE ⟦1⟧ reworded\n```\n\nShort line.",
  });
  // ⟦1⟧ still present (masks ok), but the block bytes changed
  expect(r.masks.ok).toBe(true);
  expect(r.code.ok).toBe(false);
});

test("runGuard: a corrupted proper name is flagged against the source", () => {
  const r = runGuard({
    ...clean,
    rewriteUnmasked: "The Levenstein distance, cited. Short line.", // dropped the 'h'
  });
  expect(r.names.corrupted).toEqual([{ found: "Levenstein", wanted: "Levenshtein" }]);
  expect(guardClean(r)).toBe(false);
});

test("runGuard: an over-cap sentence is flagged", () => {
  const long = Array.from({ length: 25 }, (_, i) => `w${i}`).join(" ") + ".";
  const r = runGuard({ ...clean, rewriteMasked: long });
  expect(r.wordcap).toHaveLength(1);
  expect(r.wordcap[0]!.words).toBe(25);
});

test("formatGuard: a clean report names each axis as OK", () => {
  const out = formatGuard(runGuard(clean));
  expect(out).toContain("- masks: OK");
  expect(out).toContain("- code: OK");
  expect(out).toContain("- names: OK");
  expect(out).toContain("- sentences: OK");
});

test("formatGuard: a broken masks axis renders a FAIL line", () => {
  const r = runGuard({ ...clean, rewriteMasked: "The ⟦0⟧ distance only.\n\n```\ncode\n```" });
  expect(formatGuard(r)).toContain("- masks: FAIL");
});
