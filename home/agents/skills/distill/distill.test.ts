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
import { REL_REGISTRY, emitRelationsBlock, ensureEpistemicStatus, slugSegment } from "./distill.ts";

// 4 levels up from this dir (skills → agents → home → /Users/vadim/nix), then into
// the vault-query lint dir that holds the canonical JSON.
const JSON_PATH = resolve(
  import.meta.dir,
  "../../../../vault-query/src/commands/lint/rel-registry.json",
);
// The shared round-trip golden: the two `## Relations` blocks both sides target.
const FIXTURE_PATH = resolve(
  import.meta.dir,
  "../../../../vault-query/tests/fixtures/relations-roundtrip.md",
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

// ---- emit ⟷ golden fixture round-trip contract (BUILD side) ----
// The golden holds two `## Relations` blocks: a multi-node note and a promoted
// single-atom card. They are two BUILD inputs sharing one REBUILD parse table, so
// the test drives emitRelationsBlock with two fixture IRs.
const goldenEdges = (): { note: string[]; card: string[] } => {
  const lines = readFileSync(FIXTURE_PATH, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("- "));
  // 3 note edges then 1 card edge, in fixture order.
  return { note: lines.slice(0, 3), card: lines.slice(3) };
};

// multi-node note combo (Glossary term-slugs: target-distance, aim-point, holdover).
// Edges live on their FROM entry; emit is entry-grouped, so target-distance's two
// edges render together (the golden interleaves them — round-trip is set-based).
const noteCombo = [
  {
    term: "target-distance",
    def: "",
    source: ["B1"],
    relations: [
      { rel: "precondition-for", to: "aim-point", predicate: "you must range before you can hold" },
      { rel: "contrast-to", to: "[[note-line-of-sight]]", predicate: null },
    ],
  },
  {
    term: "aim-point",
    def: "",
    source: ["B1"],
    relations: [{ rel: "subsumes", to: "holdover", predicate: null }],
  },
];

// single-atom card combo (single atom: holdover) — from-label omitted.
const cardCombo = [
  {
    term: "holdover",
    def: "",
    source: ["B1"],
    relations: [
      {
        rel: "precondition-for",
        to: "[[note-graph-demo]]",
        predicate: "holdover presupposes a ranged target",
      },
    ],
  },
];

test("emitRelationsBlock: single-atom card omits from-label, byte-equals golden card block", () => {
  const { card } = goldenEdges();
  expect(emitRelationsBlock(cardCombo)).toBe(`## Relations\n\n${card.join("\n")}`);
});

test("emitRelationsBlock: multi-node note prefixes from-label, round-trips the golden edge set", () => {
  const { note } = goldenEdges();
  const emitted = emitRelationsBlock(noteCombo)
    .split("\n")
    .filter((l) => l.startsWith("- "));
  // set equality: emit is entry-grouped, the golden hand-authored order interleaves;
  // REBUILD parses an edge SET (D29), so both rebuild identically.
  expect(new Set(emitted)).toEqual(new Set(note));
});

test("emitRelationsBlock: multi-node note byte-stable entry-grouped form", () => {
  expect(emitRelationsBlock(noteCombo)).toBe(
    "## Relations\n\n" +
      "- target-distance precondition-for:: aim-point (you must range before you can hold)\n" +
      "- target-distance contrast-to:: [[note-line-of-sight]]\n" +
      "- aim-point subsumes:: holdover",
  );
});

test("emitRelationsBlock: no edges yields empty string", () => {
  expect(emitRelationsBlock([{ term: "x", def: "", source: ["B1"], relations: [] }])).toBe("");
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
