// writing/levenshtein tests — pinned distances for the plain and bounded variants.
import { expect, test } from "bun:test";
import { levenshtein, levenshteinBounded } from "textkit/core/writing/levenshtein.ts";

test("levenshtein: pinned distances", () => {
  expect(levenshtein("firecurl", "firecrawl")).toBe(3);
  expect(levenshtein("firecrawler", "firecrawl")).toBe(2);
  expect(levenshtein("", "abc")).toBe(3);
  expect(levenshtein("same", "same")).toBe(0);
});

test("levenshteinBounded: agrees with levenshtein within the bound, saturates beyond", () => {
  expect(levenshteinBounded("firecurl", "firecrawl", 3)).toBe(3);
  expect(levenshteinBounded("firecurl", "firecrawl", 2)).toBe(3); // saturated: bound+1
  expect(levenshteinBounded("same", "same", 0)).toBe(0);
  expect(levenshteinBounded("", "abc", 5)).toBe(3);
  expect(levenshteinBounded("abc", "", 2)).toBe(3); // length delta short-circuit
  // trim + row-min early exit keep a 20k-char near-identical pair instant
  const big = "lorem ipsum dolor sit amet ".repeat(800);
  const edited = `${big.slice(0, 10000)}X${big.slice(10001)}`;
  expect(levenshteinBounded(big, edited, Math.ceil(0.15 * big.length))).toBe(1);
  const rewritten = "something else entirely here ".repeat(750);
  const bound = Math.ceil(0.15 * big.length);
  expect(levenshteinBounded(big, rewritten, bound)).toBe(bound + 1);
});
