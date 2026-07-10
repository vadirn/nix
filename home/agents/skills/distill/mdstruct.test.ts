// mdstruct-harvester golden tests — run with `bun test` from this directory (needs the
// `mdstruct` binary on PATH; the nix host has it at /run/current-system/sw/bin/mdstruct).
//
// Backlog 5a migrated the four structural payload harvesters (fences, blockquotes, table
// rows, image embeds) from hand-rolled line-scanning regex to mdstruct byte-spans. The
// Backlog-9 residue-parity gate proved the swap is residue-safe over 998 vault files; these
// in-repo goldens pin the SPECIFIC correctness classes that motivated it, one per class, so
// the fix is guarded without a vault dependency. Each class was a regex bug that produced
// phantom "dropped payload" residue (a false warning) or missed real payload.
import { execFileSync } from "node:child_process";
import { expect, test } from "bun:test";
import {
  harvestBlockquotes,
  harvestFences,
  harvestImages,
  harvestTableRows,
  payloadMask,
  payloadDensity,
  routeSection,
  sections,
  structuralSpans,
  wordCount,
} from "./text.ts";
import { parseDoc, sliceBytes } from "./mdstruct.ts";

// Regions overlay (additive, schema 1.1). `parseDoc(doc, { regions: ["interact"] })` registers the
// `interact` comment-anchor label, so the `<!-- interact: … --> … <!-- /interact -->` pair surfaces
// in `doc.regions` with byte-exact `span`/`bodySpan` and the whole post-`interact:` string as `info`.
// The no-opts `parseDoc(doc)` call must stay untouched: region-free (the binary emits `regions: []`
// when no label is registered, so no region ever surfaces) and the SAME cache key as before (the
// parsed object is identical across both no-opts calls — same entry, back-compat).
test("parseDoc: --region surfaces the interact anchor pair; no-opts stays region-free on the same key", () => {
  const doc =
    "# T\n\n<!-- interact: click to expand -->\nhidden body\n<!-- /interact -->\n\nAfter.\n";

  const { doc: withRegions, buf } = parseDoc(doc, { regions: ["interact"] });
  expect(withRegions.regions?.length).toBe(1);
  const r = withRegions.regions![0];
  expect(r.label).toBe("interact");
  expect(r.info).toBe("click to expand"); // the whole post-`interact:` string
  // span covers both anchor lines; bodySpan is the raw bytes between them.
  expect(sliceBytes(buf, r.span)).toBe(
    "<!-- interact: click to expand -->\nhidden body\n<!-- /interact -->\n",
  );
  expect(sliceBytes(buf, r.bodySpan)).toBe("hidden body\n");

  // No-opts path is unchanged: no region surfaces (binary emits `regions: []`), and it hits the
  // same cache entry across calls — proving the label-suffix key-fix left the `text`-only key intact.
  const first = parseDoc(doc);
  expect(first.doc.regions?.length ?? 0).toBe(0);
  expect(parseDoc(doc)).toBe(first); // byte-for-byte same key → same cached ParsedDoc
});

// S7 fence-skip (schema 1.1, opt-in). `--region-skip-fenced` is a fresh flag: the nix PATH binary
// predates it, so this case is capability-gated on the RESOLVED binary (MDSTRUCT_BIN ?? "mdstruct")
// advertising it in `--help`. When absent it is test.skip'd (kept green for everyone); when present
// it runs against a binary that has the flag (e.g. the debug build via MDSTRUCT_BIN).
const MDSTRUCT_BIN = process.env.MDSTRUCT_BIN ?? "mdstruct";
const SUPPORTS_SKIP_FENCED = (() => {
  try {
    return execFileSync(MDSTRUCT_BIN, ["--help"], { encoding: "utf8" }).includes(
      "region-skip-fenced",
    );
  } catch {
    return false;
  }
})();

// S7 doc: the `interact` OPEN sits outside any fence; a STRAY `<!-- /interact -->` sits inside a real
// fenced code block; the REAL close follows after the fence. Without the flag, region::scan pairs the
// open with the stray (fenced) close → a mispaired, too-short region. With `--region-skip-fenced`, the
// fenced anchor is ignored and the region spans to the real close.
const S7_DOC =
  "# T\n\n<!-- interact: demo -->\nreal body line\n\n```text\n<!-- /interact -->\n```\n\nmore real body\n<!-- /interact -->\n\nAfter.\n";

(SUPPORTS_SKIP_FENCED ? test : test.skip)(
  SUPPORTS_SKIP_FENCED
    ? "parseDoc: --region-skip-fenced spans past a stray fenced close to the REAL close (S7)"
    : "parseDoc: --region-skip-fenced S7 [SKIPPED: resolved mdstruct predates the flag]",
  () => {
    const skipped = parseDoc(S7_DOC, { regions: ["interact"], skipFencedAnchors: true });
    const mispaired = parseDoc(S7_DOC, { regions: ["interact"] });
    const rS = skipped.doc.regions![0];
    const rM = mispaired.doc.regions![0];

    // With the flag: the region reaches the real close — its body carries the post-fence payload.
    expect(sliceBytes(skipped.buf, rS.bodySpan)).toBe(
      "real body line\n\n```text\n<!-- /interact -->\n```\n\nmore real body\n",
    );
    expect(sliceBytes(skipped.buf, rS.span)).toContain("more real body");

    // Without the flag: the region closes early at the fenced stray anchor — a strictly shorter span
    // whose body stops at the fence, missing the real payload after it.
    expect(sliceBytes(mispaired.buf, rM.bodySpan)).toBe("real body line\n\n```text\n");
    expect(sliceBytes(mispaired.buf, rM.bodySpan)).not.toContain("more real body");
    expect(rS.span[1]).toBeGreaterThan(rM.span[1]); // fence-aware span extends past the mispaired one

    // The flag keys differently: a distinct cache entry from the no-flag call (flag ⇒ suffix).
    expect(skipped).not.toBe(mispaired);
  },
);

// Default-path invariant: with no `skipFencedAnchors`, the key gains no flag suffix, so a repeated
// call resolves to the SAME cached object on both the plain and region paths (binary-independent —
// runs on the PATH binary too, since it never passes the flag).
test("parseDoc: no skipFencedAnchors ⇒ no flag suffix, so the default-path key is unchanged", () => {
  expect(parseDoc(S7_DOC)).toBe(parseDoc(S7_DOC));
  expect(parseDoc(S7_DOC, { regions: ["interact"] })).toBe(
    parseDoc(S7_DOC, { regions: ["interact"] }),
  );
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

// ---- router migration goldens: structuralSpans-fed payloadMask + sections (one per class) ----
// The four harvesters above feed the residue inventory; these pin the SECOND consumer of the
// same detection (D2) — the density router's payloadMask/sections — over the divergence classes
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
