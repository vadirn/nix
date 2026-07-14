// distill parity tests — run with `bun test` from this directory.
//
// Net-new harness: distill has no prior test suite. This file owns the TS side of the
// relations-registry reconciliation. The Rust side owns its own assertion in
// vault-query/src/commands/lint/relations.rs (`registry_parity`). Both pin against the
// same canonical ground truth, vault-query/src/commands/lint/rel-registry.json, so the
// two language-native copies cannot drift silently.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "bun:test";
import { REL_REGISTRY, ensureEpistemicStatus, slugSegment } from "./distill.ts";
import { parseRelationsBlock } from "./rel-parse.ts";

// 4 levels up from this dir (skills → agents → home → /Users/vadim/nix), then into
// the vault-query lint dir that holds the canonical JSON.
const JSON_PATH = resolve(
  import.meta.dir,
  "../../../../../vault-query/src/commands/lint/rel-registry.json",
);

test("REL_REGISTRY matches canonical rel-registry.json", () => {
  const fromJson: string[] = JSON.parse(readFileSync(JSON_PATH, "utf8"));
  expect(new Set(REL_REGISTRY)).toEqual(new Set(fromJson));
});

// ---- slug parity: TS slugSegment mirrors vault-query slug.rs::segment ----
test("slugSegment mirrors normalize_segment", () => {
  expect(slugSegment("Target distance")).toBe("target-distance");
  expect(slugSegment("aim-point")).toBe("aim-point");
  expect(slugSegment("[[note-line-of-sight]]")).toBe("note-line-of-sight");
  expect(slugSegment("`Foo`*_Bar_")).toBe("foobar"); // backtick/*/_ stripped, not slugged
  expect(slugSegment("  Holdover  ")).toBe("holdover"); // outer non-alnum trims
});

// ---- epistemic_status default: distilled output is provisional until curated ----
test("ensureEpistemicStatus: inserts before the closing fence, other lines byte-stable", () => {
  const front = "---\ntype: note\ndescription: A pinned anchor\n---\n";
  expect(ensureEpistemicStatus(front)).toBe(
    "---\ntype: note\ndescription: A pinned anchor\nepistemic_status: provisional\n---\n",
  );
});

test("ensureEpistemicStatus: leaves an existing status verbatim (explicit choice wins)", () => {
  const front = "---\ntype: note\nepistemic_status: certified\n---\n";
  expect(ensureEpistemicStatus(front)).toBe(front);
});

test("ensureEpistemicStatus: empty front creates a minimal block", () => {
  expect(ensureEpistemicStatus("")).toBe("---\nepistemic_status: provisional\n---\n");
});

test("ensureEpistemicStatus: preserves CRLF line endings byte-for-byte", () => {
  const front = "---\r\ntype: note\r\n---\r\n";
  expect(ensureEpistemicStatus(front)).toBe(
    "---\r\ntype: note\r\nepistemic_status: provisional\r\n---\r\n",
  );
});

test("ensureEpistemicStatus: honors a `...` closing fence", () => {
  const front = "---\ntype: note\n...\n";
  expect(ensureEpistemicStatus(front)).toBe(
    "---\ntype: note\nepistemic_status: provisional\n...\n",
  );
});

// ---- parseRelationsBlock: parse an emitted note's `## Relations` block back into
// structural edges. Grammar parity vs vault-query's relations.rs is checked in text.ts
// (see the divergence comment above splitPredicate there); these pins exercise the
// lossy-tolerant line grammar directly.
test("parseRelationsBlock: lossy — skips malformed lines, keeps the well-formed one", () => {
  const md = [
    "## Relations",
    "",
    "- not an edge at all",
    "- a subsumes:: b",
    "- dangling rel::",
  ].join("\n");
  expect(parseRelationsBlock(md)).toEqual([
    { from: "a", rel: "subsumes", to: "b", predicate: null },
  ]);
});

test("parseRelationsBlock: list items outside a Relations section are ignored", () => {
  const md = "## Other\n\n- foo bar:: baz\n\n## Relations\n\n- a subsumes:: b\n";
  expect(parseRelationsBlock(md)).toEqual([
    { from: "a", rel: "subsumes", to: "b", predicate: null },
  ]);
});

test("parseRelationsBlock: section closes at the next heading", () => {
  const md = "## Relations\n\n- a subsumes:: b\n\n## Notes\n\n- c refines:: d\n";
  expect(parseRelationsBlock(md)).toEqual([
    { from: "a", rel: "subsumes", to: "b", predicate: null },
  ]);
});

test("parseRelationsBlock: unknown rel token is parsed and kept (open vocabulary)", () => {
  const md = "## Relations\n\n- a relates-to:: b\n";
  expect(parseRelationsBlock(md)).toEqual([
    { from: "a", rel: "relates-to", to: "b", predicate: null },
  ]);
});

// A demoted `### Relations` inside a preserved source section is source material, not a
// channel: the H2-only section toggle (text.ts::extractSection) must ignore the demoted
// H3 so a preserve section's own edge list never parses as channel edges (live-run finding).
test("parseRelationsBlock: a demoted ### Relations in a preserve section is not read as channel", () => {
  const md = [
    "## Relations",
    "",
    "- quality subsumes:: satisficers",
    "",
    "### Relations",
    "",
    "- accuracy contrast-to:: precision",
  ].join("\n");
  expect(parseRelationsBlock(md)).toEqual([
    { from: "quality", rel: "subsumes", to: "satisficers", predicate: null },
  ]);
});
