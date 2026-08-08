// simplify/wordcap tests — the 20-word-cap scan on synthetic prose: it flags over-cap sentences,
// skips structure (fences, headings, tables), strips list markers, and counts a frozen ⟦N⟧ span as
// one referent. Pure, offline.
import { expect, test } from "bun:test";
import { wordCapScan } from "textkit/simplify/wordcap.ts";

const words = (n: number): string => Array.from({ length: n }, (_, i) => `w${i}`).join(" ") + ".";

test("wordCapScan: a 25-word sentence is flagged; a 20-word one is not", () => {
  expect(wordCapScan(words(25))).toEqual([{ sentence: words(25).trim(), words: 25 }]);
  expect(wordCapScan(words(20))).toEqual([]);
});

test("wordCapScan: splits a line into sentences and flags only the long one", () => {
  const line = `${words(25)} ${words(5)}`;
  const found = wordCapScan(line);
  expect(found).toHaveLength(1);
  expect(found[0]!.words).toBe(25);
});

test("wordCapScan: headings, table rows, and fenced code never count as prose", () => {
  const doc = [
    `# ${words(30)}`, // heading
    "```", // fenced code opener
    words(40), // code line — not prose
    "```",
    `| ${words(30)} | cell |`, // table row
  ].join("\n");
  expect(wordCapScan(doc)).toEqual([]);
});

test("wordCapScan: a leading list marker is stripped before counting", () => {
  // 21 prose words after the "- " bullet: the marker itself must not be counted.
  const item = `- ${words(21)}`;
  const found = wordCapScan(item);
  expect(found).toHaveLength(1);
  expect(found[0]!.words).toBe(21);
});

test("wordCapScan: a ⟦N⟧ span counts as one referent, keeping a masked sentence under the cap", () => {
  // 19 plain words + one ⟦0⟧ span = 20 referents; unmasked, the span's inner words would push it over.
  const sentence = `${Array.from({ length: 19 }, (_, i) => `w${i}`).join(" ")} ⟦0⟧.`;
  expect(wordCapScan(sentence)).toEqual([]);
});

test("wordCapScan: a bold lead ends a sentence, so `.**` is a boundary and not a merge", () => {
  // The Simplified style writes bold leads, so a sentence routinely ends at `.**`. Both halves here
  // sit under the cap; only a splitter blind to the closing `**` would merge them into a phantom
  // 26-word offender and push the pre-hint to split compliant prose.
  const line = `**${words(8)}** ${words(16)}`;
  expect(wordCapScan(line)).toEqual([]);
  // and the merge it replaces would have been over the cap, so the test genuinely discriminates
  expect(8 + 1 + 16).toBeGreaterThan(20); // +1 for the bold marker word-joining
});

test("wordCapScan: closing quotes and brackets also end a sentence", () => {
  for (const closer of ['"', "'", ")", "]", "”", "’", "»", "`", "_"]) {
    const line = `${words(8).slice(0, -1)}.${closer} ${words(16)}`;
    expect(wordCapScan(line)).toEqual([]);
  }
});

test("wordCapScan: findings come back longest first", () => {
  const doc = `${words(22)}\n${words(30)}`;
  expect(wordCapScan(doc).map((f) => f.words)).toEqual([30, 22]);
});
