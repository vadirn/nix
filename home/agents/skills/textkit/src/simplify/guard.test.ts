// simplify/guard tests — the five advisory axes on synthetic input/rewrite pairs: mask survival,
// fenced-code intactness, name corruption against source, the word-cap scan, and list structure
// (kind flip, a new block under the member floor, and structure the scan could not confirm). Plus
// guardClean and the formatGuard rendering. Pure, offline.
import { expect, test } from "bun:test";
import { type GuardInput, formatGuard, guardClean, runGuard } from "textkit/simplify/guard.ts";

// A clean baseline: masks survive (reordered but same multiset), the fenced block is byte-identical,
// no name drifts, every sentence is short, and neither side carries a list. Individual tests
// override one field to break one axis.
const clean: GuardInput = {
  source: "We cite the Levenshtein distance. See the notes.",
  maskedInput: "We cite the ⟦0⟧ distance.\n\n```\ncode ⟦1⟧\n```\n\nShort line.",
  rewriteMasked: "The ⟦0⟧ distance, cited.\n\n```\ncode ⟦1⟧\n```\n\nShort line.",
  rewriteUnmasked: "The Levenshtein distance, cited. Short line.",
  sequences: [],
  lang: "en",
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
    ...clean,
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
    ...clean,
    source: "steps",
    maskedInput: "1. first\n2. second\n3. third",
    rewriteMasked: "1. First.\n2. Second.\n3. Third.",
    rewriteUnmasked: "1. First.\n2. Second.\n3. Third.",
  });
  expect(r.list.ok).toBe(true);
  expect(guardClean(r)).toBe(true);
});

test("runGuard: a SHAPE transform the scan confirmed is not a flip and is not unconfirmed", () => {
  // The source had no list; the rewrite turns a prose set into three bullets. A new kind appearing
  // is a legitimate SHAPE transform, not a vanished kind. The scan confirmed the sentence and its
  // three members, so the added block and items are exactly what it licensed and nothing overruns.
  const r = runGuard({
    ...clean,
    source: "a set of three things",
    maskedInput: "We track alpha, beta, and gamma.",
    rewriteMasked: "We track three things:\n\n- alpha\n- beta\n- gamma",
    rewriteUnmasked: "We track three things:\n\n- alpha\n- beta\n- gamma",
    sequences: [{ sentence: "We track alpha, beta, and gamma.", members: 3 }],
  });
  expect(r.list.ok).toBe(true);
  expect(r.list.rewrite.unordered).toBe(3);
  expect(r.list.unconfirmed).toEqual({ blocks: 0, items: 0, candidates: 1, budget: 3 });
  expect(guardClean(r)).toBe(true);
});

test("runGuard: a new list block under the member floor trips SHORT", () => {
  // The observed failure on a real note: a prose PAIR became a two-item list. The ruleset builds a
  // list only at three or more members, so this is certain — no scan and no language enter into it.
  const r = runGuard({
    ...clean,
    source: "a pair",
    maskedInput: "Two strands were deferred: fetch adapters and collection hygiene.",
    rewriteMasked: "Two strands were deferred:\n\n- fetch adapters\n- collection hygiene",
    rewriteUnmasked: "Two strands were deferred:\n\n- fetch adapters\n- collection hygiene",
  });
  expect(r.list.short).toEqual({ source: 0, rewrite: 1 });
  expect(r.list.ok).toBe(false);
  expect(formatGuard(r)).toContain("- lists: SHORT");
  expect(formatGuard(r)).toContain("a pair stays prose");
});

test("runGuard: structure beyond the scan's confirmation reports UNCONFIRMED, and asks for a check", () => {
  // The scan reads an Oxford series and a semicolon set only, so a real non-Oxford series converts
  // legitimately and still lands here. The finding must therefore read as a pointer, never a
  // verdict: taking it as one would re-impose the closed worklist the tool deliberately dropped.
  const r = runGuard({
    ...clean,
    source: "a ladder",
    maskedInput: "The verdict ladder runs cut, rewrite, leave.",
    rewriteMasked: "The verdict ladder runs:\n\n- cut\n- rewrite\n- leave",
    rewriteUnmasked: "The verdict ladder runs:\n\n- cut\n- rewrite\n- leave",
  });
  expect(r.list.unconfirmed).toEqual({ blocks: 1, items: 3, candidates: 0, budget: 0 });
  expect(r.list.ok).toBe(false);
  const out = formatGuard(r);
  expect(out).toContain("- lists: UNCONFIRMED");
  expect(out).toContain("keep it if it does");
  expect(out).not.toContain("FLIP");
});

test("runGuard: Russian leaves the structure reading unmeasured rather than firing on every list", () => {
  // 251 Russian vault files yield 5 scan findings against 1360 from 913 English ones, so an
  // English-shaped budget would fire on any Russian note that gains a list. The contract the model
  // receives is identical in both languages; only this measurement's reach differs.
  const ru: GuardInput = {
    ...clean,
    source: "перечисление",
    maskedInput: "Проверка читает, разбирает и печатает результат.",
    rewriteMasked: "Проверка:\n\n- читает\n- разбирает\n- печатает результат",
    rewriteUnmasked: "Проверка:\n\n- читает\n- разбирает\n- печатает результат",
    lang: "ru",
  };
  const r = runGuard(ru);
  expect(r.list.unconfirmed).toBeNull();
  expect(r.list.ok).toBe(true);
  expect(guardClean(r)).toBe(true);
  expect(formatGuard(r)).toContain("structure unmeasured (RU)");
  // The same rewrite in English WOULD be reported, which is the reach difference, not a rule change.
  expect(runGuard({ ...ru, lang: "en" }).list.ok).toBe(false);
});

test("runGuard: the SHORT reading is language-neutral, so Russian keeps it", () => {
  const r = runGuard({
    ...clean,
    source: "пара",
    maskedInput: "Отложены две ветки: адаптеры и гигиена коллекции.",
    rewriteMasked: "Отложены две ветки:\n\n- адаптеры\n- гигиена коллекции",
    rewriteUnmasked: "Отложены две ветки:\n\n- адаптеры\n- гигиена коллекции",
    lang: "ru",
  });
  expect(r.list.unconfirmed).toBeNull();
  expect(r.list.short).toEqual({ source: 0, rewrite: 1 });
  expect(r.list.ok).toBe(false);
  expect(formatGuard(r)).toContain("- lists: SHORT");
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
