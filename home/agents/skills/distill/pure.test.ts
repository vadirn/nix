// pure-helper tests — run with `bun test` from this directory.
//
// 17a split distill.ts into leaf modules whose helpers are pure string/data
// functions with no I/O. This suite pins those helpers directly now that they are
// importable: the text utilities (text.ts), the balanced-JSON extractor over loose
// model output (fw.ts::extractJson), and the distilled-body parser that render mode
// inverts the compress pipeline through (render-mode.ts::parseDistilled). It also
// pins the one hardening this step adds — parseDistilled drops a term row with no
// definition, malformed glossary output the model produced by splitting a row.
import { expect, test } from "bun:test";
import {
  detectLang,
  glossList,
  harvestWikilinks,
  hasOperational,
  hasWikilink,
  normalizeRelation,
  normalizeTypography,
  relText,
  segment,
  slugSegment,
  wordCount,
} from "./text.ts";
import { extractJson } from "./fw.ts";
import { parseDistilled } from "./render-mode.ts";

// ---- text.ts: segmentation ----
test("segment: splits on blank lines into B-indexed blocks", () => {
  expect(segment("para one\n\npara two")).toEqual([
    { id: "B1", text: "para one" },
    { id: "B2", text: "para two" },
  ]);
});

test("segment: a fenced code block stays one whole block, blank line included", () => {
  const blocks = segment("```\ncode\n\nmore\n```");
  expect(blocks).toHaveLength(1);
  expect(blocks[0].text).toBe("```\ncode\n\nmore\n```");
});

// ---- text.ts: small utilities ----
test("wordCount: whitespace-collapsed token count, empty is zero", () => {
  expect(wordCount("  hello   world ")).toBe(2);
  expect(wordCount("")).toBe(0);
  expect(wordCount("   ")).toBe(0);
});

test("glossList: renders `- term: def` lines", () => {
  expect(
    glossList([
      { term: "a", def: "x" },
      { term: "b", def: "y" },
    ]),
  ).toBe("- a: x\n- b: y");
});

test("hasWikilink: detects [[...]] and ![[...]] embeds", () => {
  expect(hasWikilink("see [[note]]")).toBe(true);
  expect(hasWikilink("embed ![[img]]")).toBe(true);
  expect(hasWikilink("plain prose")).toBe(false);
});

test("hasOperational: detects code, CLI flags, and paths", () => {
  expect(hasOperational("use `code` here")).toBe(true);
  expect(hasOperational("run --verbose")).toBe(true);
  expect(hasOperational("see /usr/bin/foo")).toBe(true);
  expect(hasOperational("plain prose only")).toBe(false);
});

// ---- text.ts: typographic normalization ----
test("normalizeTypography: maps typeset glyphs back to source ASCII", () => {
  expect(normalizeTypography("“hi” it’s")).toBe('"hi" it\'s');
  expect(normalizeTypography("done…")).toBe("done...");
  expect(normalizeTypography("1–2")).toBe("1-2"); // en dash → hyphen
});

test("normalizeTypography: an em dash becomes a spaced em dash without eating newlines", () => {
  expect(normalizeTypography("a—b")).toBe("a — b");
  expect(normalizeTypography("a—\nb")).toBe("a — \nb");
});

// ---- text.ts: slugging (Cyrillic survives; ASCII parity lives in distill.test.ts) ----
test("slugSegment: collapses Unicode-letter runs, keeping Cyrillic", () => {
  expect(slugSegment("Привет Мир")).toBe("привет-мир");
});

// ---- text.ts: relation coercion ----
test("normalizeRelation: lowercases + hyphenates rel, keeps a present predicate", () => {
  expect(normalizeRelation({ rel: "precondition for", to: "aim-point", predicate: "x" })).toEqual({
    rel: "precondition-for",
    to: "aim-point",
    predicate: "x",
  });
});

test("normalizeRelation: an empty predicate collapses to null", () => {
  expect(normalizeRelation({ rel: "subsumes", to: "holdover", predicate: "" })).toEqual({
    rel: "subsumes",
    to: "holdover",
    predicate: null,
  });
});

test("normalizeRelation: drops an edge missing rel or to, or a non-object", () => {
  expect(normalizeRelation({ to: "x" })).toBeNull();
  expect(normalizeRelation({ rel: "subsumes" })).toBeNull();
  expect(normalizeRelation(null)).toBeNull();
  expect(normalizeRelation("not an object")).toBeNull();
});

test("relText: renders `rel :: to` and appends a present predicate", () => {
  expect(relText({ rel: "subsumes", to: "holdover", predicate: null })).toBe(
    "subsumes :: holdover",
  );
  expect(relText({ rel: "depends-on", to: "x", predicate: "p" })).toBe("depends-on :: x (p)");
});

// ---- text.ts: language detection ----
test("detectLang: Cyrillic-majority is ru, Latin is en, letterless defaults to en", () => {
  expect(detectLang("hello world")).toBe("en");
  expect(detectLang("привет мир")).toBe("ru");
  expect(detectLang("123 !!!")).toBe("en");
});

// ---- fw.ts: balanced-JSON extraction over loose model output ----
test("extractJson: returns a clean object verbatim", () => {
  expect(extractJson('{"a":1}')).toBe('{"a":1}');
});

test("extractJson: pulls the first balanced object out of surrounding reasoning", () => {
  expect(extractJson('thinking... {"prose":"hi"} trailing text')).toBe('{"prose":"hi"}');
});

test("extractJson: respects nesting and braces inside strings", () => {
  expect(extractJson('x {"a":{"b":1}} y')).toBe('{"a":{"b":1}}');
  expect(extractJson('{"a":"}"}')).toBe('{"a":"}"}'); // brace in a string value
});

test("extractJson: throws on no object and on an unbalanced object", () => {
  expect(() => extractJson("no braces here")).toThrow(/no JSON/);
  expect(() => extractJson('{"a":1')).toThrow(/unbalanced JSON/);
});

// ---- render-mode.ts: parseDistilled ----
test("parseDistilled: splits tie, glossary entries, and skips header/separator rows", () => {
  const body = [
    "Tie-together prose line.",
    "",
    "## Glossary",
    "",
    "| Term | Definition |",
    "| --- | --- |",
    "| alpha | first letter |",
    "| beta | second letter |",
  ].join("\n");
  const { tie, entries, preserved } = parseDistilled(body);
  expect(tie).toBe("Tie-together prose line.");
  expect(entries).toEqual([
    { term: "alpha", def: "first letter" },
    { term: "beta", def: "second letter" },
  ]);
  expect(preserved).toBe("");
});

test("parseDistilled: preserves a ## Workflow section verbatim, never folds it into prose", () => {
  const body = [
    "Thesis prose.",
    "",
    "## Workflow",
    "",
    "- step one",
    "",
    "## Glossary",
    "",
    "| a | def a |",
  ].join("\n");
  const { tie, entries, preserved } = parseDistilled(body);
  expect(tie).toBe("Thesis prose.");
  expect(entries).toEqual([{ term: "a", def: "def a" }]);
  expect(preserved).toBe("## Workflow\n\n- step one");
});

test("parseDistilled: no ## Glossary table yields the whole body as tie, no entries", () => {
  const body = "Just prose.\n\n## Workflow\n\n- step";
  const { tie, entries, preserved } = parseDistilled(body);
  expect(tie).toBe("Just prose.\n\n## Workflow\n\n- step");
  expect(entries).toEqual([]);
  expect(preserved).toBe("");
});

test("parseDistilled: unescapes a \\| inside a definition cell", () => {
  const body = ["## Glossary", "", "| a | x \\| y |"].join("\n");
  const { entries } = parseDistilled(body);
  expect(entries).toEqual([{ term: "a", def: "x | y" }]);
});

// ---- render-mode.ts: parseDistilled hardening (this step) ----
test("parseDistilled: drops a malformed row whose definition cell is empty", () => {
  const body = ["## Glossary", "", "| alpha | first |", "| beta | |"].join("\n");
  const { entries } = parseDistilled(body);
  // beta has no definition (the model split or dropped a row) — skipped, not
  // emitted as an empty-def entry into the render prompt.
  expect(entries).toEqual([{ term: "alpha", def: "first" }]);
});

test("parseDistilled: a single-cell row (no definition column) is skipped, not a crash", () => {
  const body = ["## Glossary", "", "| gamma |", "| delta | real def |"].join("\n");
  const { entries } = parseDistilled(body);
  expect(entries).toEqual([{ term: "delta", def: "real def" }]);
});

test("harvestWikilinks: extracts targets as slugs, strips alias and embed syntax", () => {
  expect(
    harvestWikilinks("see [[30 notes/Elegant solution]] and ![[img.png]] and [[Foo|bar]]"),
  ).toEqual([
    { markup: "[[30 notes/Elegant solution]]", slug: "30-notes-elegant-solution" },
    { markup: "![[img.png]]", slug: "img-png" },
    { markup: "[[Foo|bar]]", slug: "foo" },
  ]);
});

test("harvestWikilinks: plain prose yields nothing", () => {
  expect(harvestWikilinks("no links here")).toEqual([]);
});

test("harvestWikilinks: a pre-slugged ## Relations endpoint is idempotent", () => {
  // emitRelationsBlock emits [[30-notes-elegant-solution]]; harvesting it must yield
  // the SAME slug as the source [[30 notes/Elegant solution]], so coverage matches.
  expect(harvestWikilinks("[[30-notes-elegant-solution]]")[0].slug).toBe(
    "30-notes-elegant-solution",
  );
});
