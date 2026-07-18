// mdstruct-harvester golden tests — run with `bun test` from this directory (needs the
// `mdstruct` binary on PATH; the nix host has it at /run/current-system/sw/bin/mdstruct).
//
// The four structural payload harvesters (fences, blockquotes, table rows, image embeds)
// migrated from hand-rolled line-scanning regex to mdstruct byte-spans. A residue-parity
// gate proved the swap is residue-safe over 998 vault files; these
// in-repo goldens pin the SPECIFIC correctness classes that motivated it, one per class, so
// the fix is guarded without a vault dependency. Each class was a regex bug that produced
// phantom "dropped payload" residue (a false warning) or missed real payload.
import { expect, test } from "bun:test";
import { wordCount } from "textkit/core/text.ts";
import {
  harvestBlockquotes,
  harvestFences,
  harvestImages,
  harvestTableRows,
  structuralSpans,
} from "textkit/distill/extract/harvest.ts";
import {
  payloadMask,
  payloadDensity,
  routeSection,
  sections,
} from "textkit/distill/extract/route.ts";
import { parseDoc, sliceBytes } from "textkit/distill/mdstruct.ts";

// Region extraction is always-on and complete: every comment-anchor pair surfaces in `doc.regions`
// with byte-exact `span`/`bodySpan` and the whole post-`interact:` string as `info`. There is no
// registration flag -- `parseDoc(text)` alone emits the region -- and the cache keys on `text`
// alone, so repeated calls hit the same entry.
test("parseDoc: the interact anchor pair surfaces unconditionally; repeat calls hit the same key", () => {
  const doc =
    "# T\n\n<!-- interact: click to expand -->\nhidden body\n<!-- /interact -->\n\nAfter.\n";

  const first = parseDoc(doc);
  const { doc: parsed, buf } = first;
  expect(parsed.regions?.length).toBe(1);
  const r = parsed.regions![0];
  expect(r.label).toBe("interact");
  expect(r.info).toBe("click to expand"); // the whole post-`interact:` string
  // span covers both anchor lines; bodySpan is the raw bytes between them.
  expect(sliceBytes(buf, r.span)).toBe(
    "<!-- interact: click to expand -->\nhidden body\n<!-- /interact -->\n",
  );
  expect(sliceBytes(buf, r.bodySpan)).toBe("hidden body\n");

  // Cache keys on `text` alone: a repeated call hits the same entry.
  expect(parseDoc(doc)).toBe(first);
});

// S7 fence-skip is now the SOLE path: fence-awareness is unconditional. The `interact` OPEN sits
// outside any fence; a STRAY `<!-- /interact -->` sits inside a real fenced code block; the REAL
// close follows after the fence. The scanner masks the fenced anchor, so the open pairs with the
// real close and the region spans the full payload -- no flag, no fence-blind alternative.
const S7_DOC =
  "# T\n\n<!-- interact: demo -->\nreal body line\n\n```text\n<!-- /interact -->\n```\n\nmore real body\n<!-- /interact -->\n\nAfter.\n";

test("parseDoc: fence-aware extraction spans past a stray fenced close to the REAL close (S7)", () => {
  const { doc: parsed, buf } = parseDoc(S7_DOC);
  const r = parsed.regions![0];

  // The region reaches the real close -- its body carries the post-fence payload.
  expect(sliceBytes(buf, r.bodySpan)).toBe(
    "real body line\n\n```text\n<!-- /interact -->\n```\n\nmore real body\n",
  );
  expect(sliceBytes(buf, r.span)).toContain("more real body");
});

// Cache invariant: `parseDoc` keys on `text` alone, so a repeated call resolves to the SAME cached
// object.
test("parseDoc: repeated calls on the same text resolve to the same cached object", () => {
  expect(parseDoc(S7_DOC)).toBe(parseDoc(S7_DOC));
});

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
// drift past every multibyte char (the sharpest failure mode of the byte-offset design).
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

// ---- router migration goldens: structuralSpans-fed payloadMask + sections (one per class) ----
// The four harvesters above feed the residue inventory; these pin the SECOND consumer of the
// same detection — the density router's payloadMask/sections — over the divergence classes
// the parity harness materialized (delimiter-row + frontmatter fix) and the structural classes
// the mask must keep covering (pseudo-table, nested fence, list-nested quote/table).

// Delimiter-row fix. The old per-line mask blanked table DATA rows (isTableDataRow) but LEFT the
// `| --- | --- |` delimiter row — phantom prose that dragged density down. structuralSpans blanks
// the whole mdstruct table span (header + delimiter + data), so the named section routes preserve.
test("payloadMask/routeSection: a GFM table's delimiter row is now masked, section routes preserve", () => {
  const section = "## T\n\n| a | b |\n| --- | --- |\n| 1 | 2 |";
  const masked = payloadMask(section);
  expect(masked).not.toContain("-"); // delimiter row is inside the masked span, no longer prose
  expect(masked.split("\n").length).toBe(section.split("\n").length); // line count preserved
  expect(routeSection(section)).toBe("preserve");
});

// The bare table (no heading) is all payload: every row, delimiter included, masks to zero prose.
test("payloadMask: a GFM table incl. its delimiter row blanks to zero prose words (density 1)", () => {
  const table = "| a | b |\n| --- | --- |\n| 1 | 2 |";
  expect(wordCount(payloadMask(table))).toBe(0);
  expect(payloadDensity(table)).toBe(1);
});

// Frontmatter fix. The old regex scanner matched `# a yaml comment` inside `---` frontmatter as
// an ATX heading and split a phantom section there; mdstruct parses the frontmatter, so the only
// heading is `## Real` and the `#` comment stays in the intro body.
test("sections: a `#` comment inside YAML frontmatter no longer splits a section (frontmatter fix)", () => {
  const note = "---\ntitle: x\n# a yaml comment\n---\n\n## Real\n\nbody";
  const heads = sections(note).map((s) => s.heading);
  expect(heads).toEqual(["", "Real"]);
  expect(heads).not.toContain("a yaml comment");
});

// Pseudo-table carve-out (class 1). A delimiter-less `- a | b` is no mdstruct table, but the
// regex fallback inside collectStructural still spans it, so the mask blanks it to zero prose.
test("payloadMask: a delimiter-less `- a | b` pseudo-table row is still masked (class-1 fallback)", () => {
  expect(wordCount(payloadMask("- a | b"))).toBe(0);
  expect(structuralSpans(parseDoc("- a | b")).length).toBe(1);
});

// Nested fence (class 3). structuralSpans emits ONE fence span for the 4-backtick outer block —
// it is not split at the inner ` ``` ` — so the whole block, inner fence included, masks to prose-free.
test("structuralSpans/payloadMask: a nested fence is one whole masked block (class 3)", () => {
  const md = "````\n```\ninner\n```\n````";
  expect(structuralSpans(parseDoc(md)).length).toBe(1);
  expect(wordCount(payloadMask(md))).toBe(0);
});

// List-nested structure (class 4). A `- > quote` behind a bullet and an indented GFM table under a
// list item are both real payload; the full-descent walk reaches them, so the mask blanks the
// quote text and the table (delimiter included), leaving only the bare list scaffold as prose.
test("payloadMask: a list-nested blockquote and an indented table are masked (class 4)", () => {
  expect(payloadMask("- > nested quote line here")).not.toContain("nested quote");
  expect(payloadDensity("- > nested quote line here")).toBeGreaterThan(0.5);
  const tbl = "- item\n\n  | a | b |\n  | --- | --- |\n  | 1 | 2 |";
  expect(payloadMask(tbl)).not.toContain("---");
  expect(payloadDensity(tbl)).toBeGreaterThan(0.7);
});
