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
import { assembleBody } from "./assemble.ts";
import { parseConceptGraph, parseRelationsBlock, type GlossEntry, type Relation } from "./text.ts";

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

test("emitRelationsBlock: drops a self-loop edge but keeps a distinct-endpoint edge", () => {
  // multi-node note so each edge keeps its from-label prefix (not the single-atom form).
  const ir = [
    {
      term: "four-reasons-to-change-code",
      def: "",
      source: ["B1"],
      relations: [
        // self-loop: from-slug === bare-local to-endpoint slug — vacuous, must drop.
        { rel: "reference", to: "four-reasons-to-change-code", predicate: null },
        // distinct endpoint — must still emit.
        { rel: "subsumes", to: "rule-of-three", predicate: null },
      ],
    },
    { term: "rule-of-three", def: "", source: ["B1"], relations: [] },
  ];
  expect(emitRelationsBlock(ir)).toBe(
    "## Relations\n\n- four-reasons-to-change-code subsumes:: rule-of-three",
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

// ---- parseRelationsBlock / parseConceptGraph: the REBUILD inverse of
// emitRelationsBlock / assembleBody's Glossary table (W1). Grammar parity vs
// vault-query's relations.rs is checked in text.ts (see the divergence comment
// above splitPredicate there); these pins exercise the round trip end to end.

// Regroup parsed edges back into a GlossEntry[] emitRelationsBlock can re-render:
// a single-atom edge set (every edge's `from` is null) becomes ONE entry (the
// from-label is never rendered for it, so `term` is arbitrary); a multi-node edge
// set groups by `from` — already the exact pre-slugged fromSlug text
// emitRelationsBlock would derive from `entry.term` via slugSegment, and
// slugSegment is idempotent on an already-slugged string, so reusing it as `term`
// reproduces the same fromSlug. NB: this reconstructs only entries an edge
// touched — an original entry with zero relations is invisible to a
// relations-only parse, so a byte-identical pin needs every entry to carry at
// least one edge (fixtures below are built that way; noteCombo/cardCombo already are).
function regroupEdges(edges: ReturnType<typeof parseRelationsBlock>): GlossEntry[] {
  const singleAtom: Relation[] = [];
  const byFrom = new Map<string, Relation[]>();
  for (const e of edges) {
    const rel: Relation = { rel: e.rel, to: e.to, predicate: e.predicate };
    if (e.from === null) singleAtom.push(rel);
    else {
      if (!byFrom.has(e.from)) byFrom.set(e.from, []);
      byFrom.get(e.from)!.push(rel);
    }
  }
  if (singleAtom.length) return [{ term: "atom", def: "", source: [], relations: singleAtom }];
  return [...byFrom.entries()].map(([term, relations]) => ({
    term,
    def: "",
    source: [],
    relations,
  }));
}

// Drives one emit → parse → re-emit round trip and asserts byte identity.
function roundTrips(entries: GlossEntry[]): void {
  const text1 = emitRelationsBlock(entries);
  const edges = parseRelationsBlock(text1);
  const text2 = emitRelationsBlock(regroupEdges(edges));
  expect(text2).toBe(text1);
}

test("parseRelationsBlock round-trip: multi-node note (golden noteCombo)", () => {
  roundTrips(noteCombo);
});

test("parseRelationsBlock round-trip: single-atom card (golden cardCombo)", () => {
  roundTrips(cardCombo);
});

test("parseRelationsBlock round-trip: [[wikilink]] endpoints incl. alias form", () => {
  const entries: GlossEntry[] = [
    {
      term: "signal",
      def: "",
      source: ["B1"],
      relations: [
        { rel: "contrast-to", to: "[[note-bare-target]]", predicate: null },
        { rel: "part-of", to: "[[note-aliased|Display Text]]", predicate: "via the alias form" },
      ],
    },
  ];
  roundTrips(entries);
});

// Pins Finding 2: idempotence (roundTrips above) is not enough — emit∘parse∘emit can be
// idempotent on a WRONG-but-stable value. The alias form must endpoint on the wikilink's
// TARGET (`note-aliased`), the note the link actually points to, never on a slug of the
// whole "target|alias" span (which would target a note that does not exist).
test("emitRelationsBlock: an alias wikilink [[target|Display Text]] endpoints on the target, not the alias", () => {
  const entries: GlossEntry[] = [
    {
      term: "signal",
      def: "",
      source: ["B1"],
      relations: [{ rel: "part-of", to: "[[note-aliased|Display Text]]", predicate: null }],
    },
  ];
  const text = emitRelationsBlock(entries);
  expect(text).toContain("[[note-aliased]]");
  expect(text).not.toContain("display-text");
  expect(text).not.toContain("note-aliased-display-text");
});

test("parseRelationsBlock round-trip: predicate with parentheses inside", () => {
  const entries: GlossEntry[] = [
    {
      term: "solo",
      def: "",
      source: ["B1"],
      relations: [{ rel: "refines", to: "other-thing", predicate: "see also (details) later" }],
    },
  ];
  roundTrips(entries);
});

test("parseRelationsBlock round-trip: Cyrillic terms", () => {
  const entries: GlossEntry[] = [
    {
      term: "Холдовер",
      def: "",
      source: ["B1"],
      relations: [{ rel: "subsumes", to: "навес", predicate: "рабочий термин" }],
    },
  ];
  roundTrips(entries);
});

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

test("parseRelationsBlock: unknown rel token is parsed and kept (open vocabulary, D32)", () => {
  const md = "## Relations\n\n- a relates-to:: b\n";
  expect(parseRelationsBlock(md)).toEqual([
    { from: "a", rel: "relates-to", to: "b", predicate: null },
  ]);
});

// ---- parseConceptGraph: Glossary table + Relations attachment over an assembleBody output ----
test("parseConceptGraph: recovers terms/defs (incl. an escaped-pipe def) and edge attachment", () => {
  const graphEntries: GlossEntry[] = [
    {
      term: "alpha",
      def: "unused, defByTerm wins",
      source: ["B1"],
      relations: [{ rel: "subsumes", to: "beta", predicate: "alpha grounds beta" }],
    },
    { term: "beta", def: "a rate | ratio thing", source: ["B2"], relations: [] },
  ];
  const defByTerm = new Map([
    ["alpha", "the first term"],
    ["beta", "a rate | ratio thing"],
  ]);
  const body = assembleBody(
    "# Title",
    "Some connective prose.",
    [],
    graphEntries,
    defByTerm,
    [],
    false,
  );
  expect(parseConceptGraph(body)).toEqual([
    {
      term: "alpha",
      def: "the first term",
      source: [],
      relations: [{ rel: "subsumes", to: "beta", predicate: "alpha grounds beta" }],
    },
    { term: "beta", def: "a rate | ratio thing", source: [], relations: [] },
  ]);
});

test("parseConceptGraph: a null-from edge over a single-row table attaches to the sole entry", () => {
  const md = [
    "## Glossary",
    "",
    "| Term | Definition |",
    "| ---- | ---------- |",
    "| holdover | keep the same aim point |",
    "",
    "## Relations",
    "",
    "- precondition-for:: [[note-graph-demo]] (holdover presupposes a ranged target)",
  ].join("\n");
  expect(parseConceptGraph(md)).toEqual([
    {
      term: "holdover",
      def: "keep the same aim point",
      source: [],
      relations: [
        {
          rel: "precondition-for",
          to: "[[note-graph-demo]]",
          predicate: "holdover presupposes a ranged target",
        },
      ],
    },
  ]);
});

test("parseConceptGraph: a null-from edge over a multi-row table has no unambiguous owner, is dropped", () => {
  const md = [
    "## Glossary",
    "",
    "| Term | Definition |",
    "| ---- | ---------- |",
    "| a | def a |",
    "| b | def b |",
    "",
    "## Relations",
    "",
    "- subsumes:: c",
  ].join("\n");
  expect(parseConceptGraph(md)).toEqual([
    { term: "a", def: "def a", source: [], relations: [] },
    { term: "b", def: "def b", source: [], relations: [] },
  ]);
});

// Pins Finding 3: a human-edited Relations line (Log 10's expected path) carries the
// from-label RAW, unslugged, exactly as the glossary row spells the term — it must still
// attach, not silently detach into an orphaned lead.
test("parseConceptGraph: an unslugged, human-typed from-label over a multi-word term still attaches", () => {
  const md = [
    "## Glossary",
    "",
    "| Term | Definition |",
    "| ---- | ---------- |",
    "| Target Distance | how far the target sits |",
    "| Holdover | keep the same aim point |",
    "",
    "## Relations",
    "",
    "- Target Distance subsumes:: holdover",
  ].join("\n");
  expect(parseConceptGraph(md)).toEqual([
    {
      term: "Target Distance",
      def: "how far the target sits",
      source: [],
      relations: [{ rel: "subsumes", to: "holdover", predicate: null }],
    },
    { term: "Holdover", def: "keep the same aim point", source: [], relations: [] },
  ]);
});
