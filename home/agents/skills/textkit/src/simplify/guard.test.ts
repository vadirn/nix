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

test("runGuard: a numbered list turned to bullets flips the list axis (advisory, guard not clean)", () => {
  // The observed #116 over-split: three numbered items promoted to bullets. ordered 3→0 is a flip.
  const r = runGuard({
    source: "steps",
    maskedInput: "1. first\n2. second\n3. third",
    rewriteMasked: "- first\n- second\n- third\n- and more\n- and more",
    rewriteUnmasked: "- first\n- second\n- third\n- and more\n- and more",
  });
  expect(r.list.ok).toBe(false);
  expect(r.list.source).toEqual({ ordered: 3, unordered: 0 });
  expect(r.list.rewrite.ordered).toBe(0);
  expect(guardClean(r)).toBe(false);
  expect(formatGuard(r)).toContain("- lists: FLIP");
});

test("runGuard: a numbered list kept numbered passes the list axis even when items are reworded", () => {
  const r = runGuard({
    source: "steps",
    maskedInput: "1. first\n2. second\n3. third",
    rewriteMasked: "1. First.\n2. Second.\n3. Third.",
    rewriteUnmasked: "1. First.\n2. Second.\n3. Third.",
  });
  expect(r.list.ok).toBe(true);
  expect(guardClean(r)).toBe(true);
});

test("runGuard: a SHAPE transform adding a new list from prose is not a flip", () => {
  // The source had no list; the rewrite turns a prose set into three bullets. A new kind appearing
  // is a legitimate SHAPE transform, not a vanished kind, so the axis stays clean.
  const r = runGuard({
    source: "a set of three things",
    maskedInput: "We track three things: alpha, beta, gamma.",
    rewriteMasked: "We track three things:\n\n- alpha\n- beta\n- gamma",
    rewriteUnmasked: "We track three things:\n\n- alpha\n- beta\n- gamma",
  });
  expect(r.list.ok).toBe(true);
  expect(r.list.rewrite.unordered).toBe(3);
  expect(guardClean(r)).toBe(true);
});

test("formatGuard: a clean report names each axis as OK", () => {
  const out = formatGuard(runGuard(clean));
  expect(out).toContain("- masks: OK");
  expect(out).toContain("- code: OK");
  expect(out).toContain("- names: OK");
  expect(out).toContain("- sentences: OK");
  expect(out).toContain("- lists: OK");
});

test("formatGuard: a broken masks axis renders a FAIL line", () => {
  const r = runGuard({ ...clean, rewriteMasked: "The ⟦0⟧ distance only.\n\n```\ncode\n```" });
  expect(formatGuard(r)).toContain("- masks: FAIL");
});
