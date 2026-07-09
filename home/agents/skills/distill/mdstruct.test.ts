// mdstruct-harvester golden tests — run with `bun test` from this directory (needs the
// `mdstruct` binary on PATH; the nix host has it at /run/current-system/sw/bin/mdstruct).
//
// Backlog 5a migrated the four structural payload harvesters (fences, blockquotes, table
// rows, image embeds) from hand-rolled line-scanning regex to mdstruct byte-spans. The
// Backlog-9 residue-parity gate proved the swap is residue-safe over 998 vault files; these
// in-repo goldens pin the SPECIFIC correctness classes that motivated it, one per class, so
// the fix is guarded without a vault dependency. Each class was a regex bug that produced
// phantom "dropped payload" residue (a false warning) or missed real payload.
import { expect, test } from "bun:test";
import { harvestBlockquotes, harvestFences, harvestImages, harvestTableRows } from "./text.ts";

// Class 3 — nested fence. A 4-backtick outer fence wraps a literal 3-backtick block. The old
// line-scanner closed the outer block at the FIRST inner ` ``` `, splitting one payload into
// two half-keys; comrak parses the outer block whole → one key carrying the inner fence intact.
test("harvestFences: a nested fence is one whole-block key, not two split halves (class 3)", () => {
  const keys = harvestFences("````\n```\ninner\n```\n````").map((s) => s.key);
  expect(keys).toEqual(["```\ninner\n```"]);
});

// Class 2 — payload documented inside code. A `> quote` written inside a code fence is code,
// not a quotation; the old blockquote regex (no code-scrub) false-flagged it as dropped.
// comrak surfaces no blockQuote node inside a codeBlock → no phantom residue.
test("harvestBlockquotes: a `>` line inside a code fence is not a blockquote (class 2)", () => {
  expect(harvestBlockquotes("```\n> not a quote\n```")).toEqual([]);
});

// Class 2 — an image/embed written inside INLINE code is documentation of syntax, not a live
// embed; the old image regex matched it anyway. comrak emits a codeSpan (no image/wikilink
// inline) → no phantom image residue.
test("harvestImages: an embed/image inside inline code is not an image (class 2)", () => {
  expect(harvestImages("Text with `![[x.png]]` and `![alt](y.png)` inline.")).toEqual([]);
});

// Class 4 — list-nested structure. A `- > quote` behind a list bullet is a real quotation, but
// the old `^\s*>` line-anchor missed it (the `>` is not at line start after the `- `). comrak
// parses it as a child blockQuote → captured.
test("harvestBlockquotes: a list-nested `- > quote` is captured (class 4)", () => {
  expect(harvestBlockquotes("- > nested quote").map((s) => s.key)).toEqual(["nested quote"]);
});

// Class 1 — pseudo-table carve-out. A `- a | b` row has no `:?-+:?` delimiter row, so it is not
// a GFM table and comrak emits no table node — but it is still structured payload the old regex
// row-scan caught. The hybrid lane's regex fallback (rows outside any mdstruct table) keeps it.
test("harvestTableRows: a delimiter-less pseudo-table row is still caught via the fallback (class 1)", () => {
  expect(harvestTableRows("- a | b").map((s) => s.key)).toEqual(["- a␟b"]);
});

// A real GFM table still yields one key per row, header included, delimiter row skipped — the
// clean swap must not regress the common case, and the fallback must not double-count its rows.
test("harvestTableRows: a real GFM table keys every row once (header kept, delimiter skipped)", () => {
  const keys = harvestTableRows("| Sign | Defect |\n| --- | --- |\n| a | b |\n| c | d |").map(
    (s) => s.key,
  );
  expect(keys).toEqual(["sign␟defect", "a␟b", "c␟d"]);
});

// Byte-fidelity — a fence body carrying multibyte Cyrillic (and a `.png`-terminal line) must key
// byte-exact. The span is sliced on Buffer BYTES, never JS UTF-16 string indices, or the offsets
// drift past every multibyte char (the Backlog-1 spike's sharpest failure mode).
test("harvestFences: a Cyrillic fence body keys byte-exact (guards the Buffer slice)", () => {
  const keys = harvestFences("```\nПривет мир\nконец.png\n```").map((s) => s.key);
  expect(keys).toEqual(["Привет мир\nконец.png"]);
});

// Clean image swap: a markdown image and an asset embed each key by target slug (the same
// invariant pure.test.ts pins for the regex era, held across the migration).
test("harvestImages: a markdown image and an asset embed each key by target slug", () => {
  const keys = harvestImages("![alt](diagram.png) and ![[Service locator.jpeg]]")
    .map((s) => s.key)
    .sort();
  expect(keys).toEqual(["diagram-png", "service-locator-jpeg"]);
});
