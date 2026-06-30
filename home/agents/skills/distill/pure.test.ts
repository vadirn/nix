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
  harvestBlockquotes,
  harvestCitations,
  harvestExternalLinks,
  harvestFences,
  harvestImages,
  harvestInternalLinks,
  harvestMath,
  harvestNumbers,
  harvestTableRows,
  harvestVaultEdges,
  harvestWikilinks,
  hasOperational,
  hasWikilink,
  isExternalUrl,
  normalizeRelation,
  normalizeTypography,
  relText,
  segment,
  slugSegment,
  wordCount,
} from "./text.ts";
import { extractJson } from "./fw.ts";
import { wikilinkResidue } from "./pipeline.ts";
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
  // ITEM B: ![[img.png]] is an asset embed (renders inline), not an edge — it is now
  // EXCLUDED. The surviving real edges carry the alias-stripped raw target.
  expect(
    harvestWikilinks("see [[30 notes/Elegant solution]] and ![[img.png]] and [[Foo|bar]]"),
  ).toEqual([
    {
      markup: "[[30 notes/Elegant solution]]",
      slug: "30-notes-elegant-solution",
      target: "30 notes/Elegant solution",
    },
    { markup: "[[Foo|bar]]", slug: "foo", target: "Foo" },
  ]);
});

test("harvestWikilinks: plain prose yields nothing", () => {
  expect(harvestWikilinks("no links here")).toEqual([]);
});

// ---- text.ts: ITEM B — asset embeds are not vault edges ----
test("harvestWikilinks: asset embed ![[diagram.png]] is not an edge", () => {
  expect(harvestWikilinks("![[diagram.png]]")).toEqual([]);
});

test("harvestWikilinks: note transclusion ![[some-note]] stays an edge", () => {
  expect(harvestWikilinks("![[some-note]]")).toEqual([
    { markup: "![[some-note]]", slug: "some-note", target: "some-note" },
  ]);
});

test("harvestWikilinks: bare [[chart.png]] (no ! embed) stays an edge", () => {
  expect(harvestWikilinks("[[chart.png]]")).toEqual([
    { markup: "[[chart.png]]", slug: "chart-png", target: "chart.png" },
  ]);
});

test("harvestWikilinks: asset ext match is case-insensitive", () => {
  expect(harvestWikilinks("![[Photo.JPG]]")).toEqual([]);
});

test("harvestWikilinks: alias is stripped before the asset test", () => {
  // target = "diagram.png" after split("|")[0], so the embed is excluded — proves
  // ASSET_RE runs on the alias-stripped target, not the raw inner text.
  expect(harvestWikilinks("![[diagram.png|caption]]")).toEqual([]);
});

test("harvestWikilinks: pdf and av embeds are excluded", () => {
  expect(harvestWikilinks("![[clip.mp4]] ![[doc.pdf]] ![[song.mp3]]")).toEqual([]);
});

test("harvestWikilinks: a fragment-bearing asset embed is still excluded", () => {
  // ASSET_RE is `$`-anchored; the asset test runs on the fragment-stripped target so a
  // page/section embed is caught despite the trailing #fragment.
  expect(harvestWikilinks("![[doc.pdf#page=2]] and ![[image.png#small]]")).toEqual([]);
});

test("harvestWikilinks: a fragment-bearing note transclusion stays an edge, slug drops the fragment", () => {
  // not an asset, so it survives; normalizeEdgeTarget strips the #fragment before
  // slugging, so the anchored form unifies on slug `some-note` with the bare `[[some-note]]`.
  expect(harvestWikilinks("![[some-note#heading]]")).toEqual([
    { markup: "![[some-note#heading]]", slug: "some-note", target: "some-note" },
  ]);
});

// ---- text.ts: CHANGE #1 — normalizeEdgeTarget unifies anchored and bare edges ----
test("harvestWikilinks: a fragment-bearing wikilink [[note#heading]] harvests slug `note`", () => {
  expect(harvestWikilinks("[[note#heading]]")).toEqual([
    { markup: "[[note#heading]]", slug: "note", target: "note" },
  ]);
});

test("harvestVaultEdges: [[note#heading]] and [x](note.md#heading) both harvest slug `note`", () => {
  expect(harvestVaultEdges("[[note#heading]] and [x](note.md#heading)")).toEqual([
    { markup: "[[note#heading]]", slug: "note", target: "note" },
    { markup: "[x](note.md#heading)", slug: "note", target: "note" },
  ]);
});

// ---- text.ts: external-link harvest (the citation lane, D38) ----
test("harvestExternalLinks: collects [text](url) with text+url, strips a title suffix", () => {
  expect(
    harvestExternalLinks('see [Pólya](https://x.test/heuristic) and [t](http://y.test "title")'),
  ).toEqual([
    { markup: "[Pólya](https://x.test/heuristic)", text: "Pólya", url: "https://x.test/heuristic" },
    { markup: '[t](http://y.test "title")', text: "t", url: "http://y.test" },
  ]);
});

test("harvestExternalLinks: excludes images and [[wikilinks]]", () => {
  // ![alt](url) is an image (lookbehind on !), [[wiki]] has no (url) to match.
  expect(harvestExternalLinks("![logo](img.png) and [[a/B]] and [[Foo|bar]]")).toEqual([]);
});

test("harvestExternalLinks: plain prose and bare wikilinks yield nothing", () => {
  expect(harvestExternalLinks("no links, just [[a wikilink]] here")).toEqual([]);
});

test("harvestWikilinks: a pre-slugged ## Relations endpoint is idempotent", () => {
  // emitRelationsBlock emits [[30-notes-elegant-solution]]; harvesting it must yield
  // the SAME slug as the source [[30 notes/Elegant solution]], so coverage matches.
  expect(harvestWikilinks("[[30-notes-elegant-solution]]")[0].slug).toBe(
    "30-notes-elegant-solution",
  );
});

// ---- text.ts: ITEM C — internal markdown links are vault edges ----
test("harvestExternalLinks: excludes a scheme-less [x](foo.md) (now a vault edge)", () => {
  expect(harvestExternalLinks("[x](foo.md)")).toEqual([]);
});

test("harvestExternalLinks: keeps mailto and protocol-relative urls", () => {
  expect(harvestExternalLinks("[m](mailto:a@b.test) and [r](//cdn.test/p)")).toEqual([
    { markup: "[m](mailto:a@b.test)", text: "m", url: "mailto:a@b.test" },
    { markup: "[r](//cdn.test/p)", text: "r", url: "//cdn.test/p" },
  ]);
});

test("isExternalUrl: classifies schemes and protocol-relative as external", () => {
  expect(isExternalUrl("https://x")).toBe(true);
  expect(isExternalUrl("mailto:a")).toBe(true);
  expect(isExternalUrl("//h")).toBe(true);
  expect(isExternalUrl("foo.md")).toBe(false);
  expect(isExternalUrl("./x")).toBe(false);
  expect(isExternalUrl("#a")).toBe(false);
});

test("harvestInternalLinks: slugs a %20-encoded relative .md path", () => {
  // the shared [^)\s]+ grammar forbids a literal space, so a spaced path is %20-encoded;
  // the decode step restores it before slugging.
  expect(harvestInternalLinks("[x](30%20notes/Elegant%20solution.md)")).toEqual([
    {
      markup: "[x](30%20notes/Elegant%20solution.md)",
      slug: "30-notes-elegant-solution",
      target: "30 notes/Elegant solution",
    },
  ]);
});

test("harvestInternalLinks: strips a leading ./", () => {
  expect(harvestInternalLinks("[r](./folder/note.md)")).toEqual([
    { markup: "[r](./folder/note.md)", slug: "folder-note", target: "folder/note" },
  ]);
});

test("harvestInternalLinks: skips an external url", () => {
  expect(harvestInternalLinks("[x](https://e.test)")).toEqual([]);
});

test("harvestInternalLinks: skips an asset link", () => {
  expect(harvestInternalLinks("[c](chart.png)")).toEqual([]);
});

test("harvestInternalLinks: skips a bare #anchor", () => {
  expect(harvestInternalLinks("[a](#sec)")).toEqual([]);
});

test("harvestVaultEdges: unions wikilinks and internal markdown links", () => {
  expect(harvestVaultEdges("[[foo]] and [b](bar.md)")).toEqual([
    { markup: "[[foo]]", slug: "foo", target: "foo" },
    { markup: "[b](bar.md)", slug: "bar", target: "bar" },
  ]);
});

// ---- pipeline.ts: wikilinkResidue — ITEM A (collision) + ITEM B/C (lanes) ----
test("wikilinkResidue: alias pair [[foo]] + [[foo|alias]] uncovered → ONE dropped residue", () => {
  const r = wikilinkResidue("see [[foo]] and [[foo|alias]]", "");
  expect(r.length).toBe(1);
  expect(r[0].term).toBe("[[foo]]");
  expect(r[0].reason).toMatch(/^wikilink dropped/);
  expect(r[0].reason).not.toMatch(/collision/);
});

test("wikilinkResidue: alias pair covered by [[foo]] → no residue", () => {
  expect(wikilinkResidue("see [[foo]] and [[foo|alias]]", "[[foo]]")).toEqual([]);
});

test("wikilinkResidue: genuine [[foo bar]] + [[foo/bar]] → collision over both, even when covered", () => {
  const r = wikilinkResidue("[[foo bar]] and [[foo/bar]]", "[[foo-bar]]");
  expect(r.map((x) => x.term)).toEqual(["[[foo bar]]", "[[foo/bar]]"]);
  for (const x of r) expect(x.reason).toMatch(/slug-collision/);
});

test("wikilinkResidue: case-only [[Foo]] + [[foo]] → collapses, one dropped, no collision", () => {
  const r = wikilinkResidue("[[Foo]] and [[foo]]", "");
  expect(r.length).toBe(1);
  expect(r[0].term).toBe("[[Foo]]");
  expect(r[0].reason).toMatch(/^wikilink dropped/);
  expect(r[0].reason).not.toMatch(/collision/);
});

test("wikilinkResidue: three same-target spellings collapse to one dropped residue", () => {
  const r = wikilinkResidue("[[foo]] [[foo|x]] [[Foo]]", "");
  expect(r.length).toBe(1);
  expect(r[0].term).toBe("[[foo]]");
});

test("wikilinkResidue: distinct slugs [[a]] + [[b]] → two dropped, no collision", () => {
  const r = wikilinkResidue("[[a]] and [[b]]", "");
  expect(r.map((x) => x.term)).toEqual(["[[a]]", "[[b]]"]);
  for (const x of r) expect(x.reason).toMatch(/^wikilink dropped/);
});

test("wikilinkResidue: 2 distinct targets over 3 markups → collision pushes all three markups", () => {
  const r = wikilinkResidue("[[foo bar]] [[foo bar|x]] [[foo/bar]]", "");
  expect(r.map((x) => x.term)).toEqual(["[[foo bar]]", "[[foo bar|x]]", "[[foo/bar]]"]);
  for (const x of r) expect(x.reason).toMatch(/slug-collision/);
});

test("wikilinkResidue: cross-lane [[foo]] + [foo](foo.md) same note → not a collision", () => {
  // both denote note 'foo' with normalized target 'foo' — one distinct target, covered.
  expect(wikilinkResidue("[[foo]] and [foo](foo.md)", "see [[foo]]")).toEqual([]);
});

test("wikilinkResidue: a dropped internal link [x](foo.md) surfaces as residue", () => {
  const r = wikilinkResidue("[x](foo.md)", "");
  expect(r.length).toBe(1);
  expect(r[0].term).toBe("[x](foo.md)");
  expect(r[0].reason).toMatch(/dropped/);
});

test("wikilinkResidue: an internal link covered by a wikilink in output is not residue", () => {
  expect(wikilinkResidue("[x](foo.md)", "see [[foo]]")).toEqual([]);
});

test("wikilinkResidue: a dropped asset embed ![[diagram.png]] yields no residue", () => {
  expect(wikilinkResidue("![[diagram.png]]", "")).toEqual([]);
});

test("wikilinkResidue: a dropped note transclusion ![[some-note]] still surfaces", () => {
  const r = wikilinkResidue("![[some-note]]", "");
  expect(r.length).toBe(1);
  expect(r[0].term).toBe("![[some-note]]");
  expect(r[0].reason).toMatch(/dropped/);
});

test("wikilinkResidue: a dropped bare [[img.png]] still surfaces (no ! embed)", () => {
  const r = wikilinkResidue("[[img.png]]", "");
  expect(r.length).toBe(1);
  expect(r[0].term).toBe("[[img.png]]");
});

test("wikilinkResidue: an asset embed covered nowhere is still not residue", () => {
  expect(wikilinkResidue("text ![[diagram.png]] more", "text more")).toEqual([]);
});

test("wikilinkResidue: an asset-extension markdown link is not an edge", () => {
  expect(wikilinkResidue("[chart](chart.png)", "")).toEqual([]);
});

// ---- pipeline.ts: CHANGE #1 — fragment strip kills the anchor-downgrade false positive ----
test("wikilinkResidue: source [[note#heading]] covered by output [[note]] yields no residue", () => {
  // both slug to `note` now (normalizeEdgeTarget strips the anchor before slugging), so
  // the output's bare link covers the source's anchored one — no false-positive residue.
  expect(wikilinkResidue("see [[note#heading]]", "see [[note]]")).toEqual([]);
});

test("wikilinkResidue: a dropped [[dropped]] absent from output STILL surfaces (safety net intact)", () => {
  const r = wikilinkResidue("see [[dropped]]", "no links here");
  expect(r.length).toBe(1);
  expect(r[0].term).toBe("[[dropped]]");
  expect(r[0].reason).toMatch(/^wikilink dropped/);
});

// ---- payload harvesters: the non-edge, non-prose loss surface ----

test("harvestFences: keys the body, ignoring the language tag and fence width", () => {
  const a = harvestFences("```js\nconst x = 1;\n```");
  const b = harvestFences("````\nconst x = 1;\n````");
  expect(a).toHaveLength(1);
  expect(a[0].key).toBe("const x = 1;");
  expect(b[0].key).toBe(a[0].key); // info-string + fence width excluded from the key
});

test("harvestFences: internal indentation is load-bearing (kept in the key)", () => {
  const a = harvestFences("```\n  indented\n```");
  const b = harvestFences("```\nindented\n```");
  expect(a[0].key).not.toBe(b[0].key);
});

test("harvestBlockquotes: a quote keys its inner text, lowercased and whitespace-collapsed", () => {
  const r = harvestBlockquotes("> The sum of\n> the parts.\n\nprose");
  expect(r).toHaveLength(1);
  expect(r[0].key).toBe("the sum of the parts.");
});

test("harvestTableRows: data rows key their cells; the delimiter row is skipped", () => {
  const t = "| Sign | Defect |\n| --- | --- |\n| a | b |\n| c | d |";
  const keys = harvestTableRows(t).map((r) => r.key);
  expect(keys).toEqual(["sign␟defect", "a␟b", "c␟d"]);
});

test("harvestTableRows: a wikilink-alias pipe in prose is not mistaken for a table row", () => {
  expect(harvestTableRows("see [[Foo|bar]] and [[Baz|qux]] here")).toEqual([]);
});

test("harvestImages: a markdown image and an asset embed each key by target slug", () => {
  const r = harvestImages("![alt](diagram.png) and ![[Service locator.jpeg]]");
  expect(r.map((x) => x.key).sort()).toEqual(["diagram-png", "service-locator-jpeg"]);
});

test("harvestImages: a non-asset transclusion ![[some-note]] is not an image", () => {
  expect(harvestImages("![[some-note]]")).toEqual([]);
});

test("harvestMath: display math keys its symbols; inline currency is not a formula", () => {
  expect(harvestMath("$$N \\le c$$").map((x) => x.key)).toEqual(["n\\lec"]);
  expect(harvestMath("it cost $5 and saved $10 overall")).toEqual([]);
});

test("harvestMath: inline $…$ with an operator is a formula", () => {
  expect(harvestMath("the bound $a < b$ holds").map((x) => x.key)).toEqual(["a<b"]);
});

test("harvestCitations: markdown, footnote-definition, and bare URLs all surface", () => {
  const src =
    "see [docs](https://a.example/x) and bare https://b.example/y\n\n[^c]: https://c.example/z";
  const keys = harvestCitations(src).map((r) => r.key);
  expect(keys).toContain("https://a.example/x");
  expect(keys).toContain("https://b.example/y");
  expect(keys).toContain("https://c.example/z");
});

test("harvestNumbers: keeps substantive figures and a multiplier, drops idiom and bare years", () => {
  const keys = harvestNumbers(
    "CISQ put it at $1.52 trillion, churn 47% with an 8x rise since 2024; see step 1 and v2",
  ).map((r) => r.key);
  expect(keys).toContain("1.52"); // $ + decimal
  expect(keys).toContain("47%"); // percent
  expect(keys).toContain("8x"); // multiplier
  expect(keys).not.toContain("2024"); // bare year, no scale word
  expect(keys).not.toContain("1"); // 'step 1' single digit
  expect(keys).not.toContain("2"); // 'v2' single digit
});

test("harvestNumbers: digits inside a URL or footnote definition are not phantom statistics", () => {
  expect(harvestNumbers("ref https://x.example/2014/390755 here")).toEqual([]);
  expect(harvestNumbers("[^a]: https://x.example/2010/22795459")).toEqual([]);
});

test("harvestNumbers: comma-grouped and plain forms share a key", () => {
  expect(harvestNumbers("1,200 items").map((r) => r.key)).toEqual(["1200"]);
});
