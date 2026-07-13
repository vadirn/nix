// writing/name-lint tests — pinned against the fixtures in fixtures/name-lint-*.md
// (verbatim excerpts of the firecurl/firecrawl and dhh incidents), plus synthetic
// cases for Cyrillic, exclusion zones, and total/never-throws behavior.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "bun:test";
import {
  formatNameLint,
  nameLintAgainstSource,
  nameLintSelfConsistency,
} from "./name-lint.ts";

const read = (name: string) => readFileSync(resolve(import.meta.dir, "../fixtures", name), "utf8");

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

test("unicode: NFC/NFD spellings of one name do not false-flag (either mode)", () => {
  const nfd = "Beyoncé"; // e + combining acute
  const nfc = "Beyoncé"; // precomposed é
  const sourceNfd = `Fans adore ${nfd} worldwide. The tour features ${nfd} nightly.`;
  const outputNfc = `${nfc} released an album. Critics praise ${nfc}.`;
  expect(nameLintAgainstSource(outputNfc, sourceNfd)).toEqual({ corrupted: [], invented: [] });
  expect(nameLintSelfConsistency(`${outputNfc} Fans queue for ${nfd}.`)).toEqual({
    corrupted: [],
    invented: [],
  });
});

test("unicode: a Cyrillic stress mark neither truncates the token nor flags", () => {
  // и́/а́ have no precomposed forms, so NFC alone cannot fold them — \p{M} keeps
  // the token whole and foldKey drops the mark
  const stressed = "Обсидиа́н";
  const doc = `Мы установили ${stressed} вчера. Сегодня Обсидиан хранит заметки.`;
  expect(nameLintSelfConsistency(doc)).toEqual({ corrupted: [], invented: [] });
  const source = "Обсидиан хранит заметки. Мы любим Обсидиан.";
  expect(nameLintAgainstSource(`Мы пишем в программе ${stressed} каждый день.`, source)).toEqual({
    corrupted: [],
    invented: [],
  });
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

// live miss: revise fronted "Firecurl" to sentence-initial position and the
// initial-only dampener swallowed the flag. The corrupted lane now skips an
// initial-only group only when the word also occurs uncapitalized.
test("corrupted lane: sentence-initial-only corruption is still flagged (both modes)", () => {
  const output = "Firecurl skills let any agent crawl the web. The pipeline is fast.";
  const source = "Firecrawl is a scraping API. Teams adopt Firecrawl.";
  expect(nameLintAgainstSource(output, source)).toEqual({
    corrupted: [{ found: "Firecurl", wanted: "Firecrawl" }],
    invented: [],
  });
  const doc = "Firecurl skills let agents crawl. Firecrawl is fast. Teams adopt Firecrawl daily.";
  expect(nameLintSelfConsistency(doc)).toEqual({
    corrupted: [{ found: "Firecurl", wanted: "Firecrawl" }],
    invented: [],
  });
});

test("corrupted lane: initial-only word with an uncapitalized sighting stays damped", () => {
  const doc =
    "Vault stores notes. The Vault syncs data. Fault tolerance matters, and a fault is survivable.";
  expect(nameLintSelfConsistency(doc)).toEqual({ corrupted: [], invented: [] });
  const source = "The Vault syncs data across devices. Vault storage is local.";
  const output = "Fault tolerance matters. The design survives a fault without losing data.";
  expect(nameLintAgainstSource(output, source)).toEqual({ corrupted: [], invented: [] });
});

test("corrupted lane: structurally capitalized ordinary-word pair stays damped", () => {
  // Definition (table header) vs Destination (checklist label): distance 3,
  // no uncapitalized sighting of either — but no mid-sentence attestation of
  // the majority either, so neither is evidenced as a proper noun
  const doc =
    "- Destination: discard after cards\n- [ ] Destination confirmed\n\n| Term | Definition |\n| --- | --- |";
  expect(nameLintSelfConsistency(doc)).toEqual({ corrupted: [], invented: [] });
});

test("invented lane: sentence-initial-only tokens stay excluded", () => {
  const output = "Zanzibar ships the release. The team reviews it.";
  const source = "A completely unrelated write-up about deployment cadence and reviews.";
  expect(nameLintAgainstSource(output, source)).toEqual({ corrupted: [], invented: [] });
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
