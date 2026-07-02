// writing/name-lint tests — pinned against the fixtures in fixtures/name-lint-*.md
// (verbatim excerpts of the firecurl/firecrawl and dhh incidents), plus synthetic
// cases for Cyrillic, exclusion zones, and total/never-throws behavior.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "bun:test";
import {
  formatNameLint,
  levenshtein,
  nameLintAgainstSource,
  nameLintSelfConsistency,
} from "./name-lint.ts";

const read = (name: string) => readFileSync(resolve(import.meta.dir, "../fixtures", name), "utf8");

test("levenshtein: pinned distances", () => {
  expect(levenshtein("firecurl", "firecrawl")).toBe(3);
  expect(levenshtein("firecrawler", "firecrawl")).toBe(2);
  expect(levenshtein("", "abc")).toBe(3);
  expect(levenshtein("same", "same")).toBe(0);
});

test("nameLintAgainstSource: Firecurl vs source — exactly one corrupted pair, no invented", () => {
  const output = read("name-lint-firecurl-draft.md");
  const source = read("name-lint-firecrawl-source.md");
  expect(nameLintAgainstSource(output, source)).toEqual({
    corrupted: [{ found: "Firecurl", wanted: "Firecrawl" }],
    invented: [],
  });
});

test("nameLintAgainstSource: DHH clean pair — zero flags", () => {
  const output = read("name-lint-dhh-body.md");
  const source = read("name-lint-dhh-source.md");
  expect(nameLintAgainstSource(output, source)).toEqual({ corrupted: [], invented: [] });
});

test("nameLintSelfConsistency: catches the Firecurl/Firecrawl split inside one doc", () => {
  const staged = read("name-lint-firecurl-staged.md");
  expect(nameLintSelfConsistency(staged)).toEqual({
    corrupted: [{ found: "Firecurl", wanted: "Firecrawl" }],
    invented: [],
  });
});

test("nameLintSelfConsistency: DHH staged doc is clean", () => {
  const staged = read("name-lint-dhh-staged.md");
  expect(nameLintSelfConsistency(staged)).toEqual({ corrupted: [], invented: [] });
});

test("nameLintAgainstSource: Cyrillic corruption is caught", () => {
  const output = "Мы пишем в Обсидане каждый день.";
  const source = "Обсидиан — это редактор. Обсидиан хранит заметки.";
  expect(nameLintAgainstSource(output, source)).toEqual({
    corrupted: [{ found: "Обсидане", wanted: "Обсидиан" }],
    invented: [],
  });
});

test("nameLintAgainstSource: exclusion zones suppress a corrupted spelling", () => {
  const source = "Firecrawl is a scraping API.";
  const inlineCode = "Use `Firecurl.scrape()` to fetch a page. It works well.";
  const fenced = "See below.\n```\nFirecurl.scrape()\n```\nIt works well.";
  const wikilink = "See [[Firecurl]] for details. It works well.";
  const masked = "See ⟦0⟧ for details. It works well."; // corrupted spelling itself masked away
  expect(nameLintAgainstSource(inlineCode, source)).toEqual({ corrupted: [], invented: [] });
  expect(nameLintAgainstSource(fenced, source)).toEqual({ corrupted: [], invented: [] });
  expect(nameLintAgainstSource(wikilink, source)).toEqual({ corrupted: [], invented: [] });
  expect(nameLintAgainstSource(masked, source)).toEqual({ corrupted: [], invented: [] });
});

test("total: never throws on empty input", () => {
  expect(nameLintAgainstSource("", "")).toEqual({ corrupted: [], invented: [] });
  expect(nameLintSelfConsistency("")).toEqual({ corrupted: [], invented: [] });
});

test("total: never throws when there are no capitalized tokens", () => {
  const output = "the quick brown fox jumps over the lazy dog.";
  const source = "a completely different sentence about nothing much at all.";
  expect(nameLintAgainstSource(output, source)).toEqual({ corrupted: [], invented: [] });
  expect(nameLintSelfConsistency(output)).toEqual({ corrupted: [], invented: [] });
});

test("formatNameLint: '' on clean result", () => {
  expect(formatNameLint({ corrupted: [], invented: [] })).toBe("");
});

test("formatNameLint: pinned string on the Firecurl/Firecrawl pair", () => {
  const result = nameLintAgainstSource(
    read("name-lint-firecurl-draft.md"),
    read("name-lint-firecrawl-source.md"),
  );
  expect(formatNameLint(result)).toBe(
    " · name-lint: 1 probable corrupted name (Firecurl ← Firecrawl)",
  );
});

test("formatNameLint: invented list capped at 5 with ellipsis", () => {
  const result = {
    corrupted: [],
    invented: ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"],
  };
  expect(formatNameLint(result)).toBe(
    " · name-lint: 6 invented (Alpha, Bravo, Charlie, Delta, Echo, …)",
  );
});
