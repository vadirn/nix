// prompt-builder tests — run with `bun test` from this directory.
//
// extractComboPrompt is a pure string builder (no model call). This suite pins the
// D38 Loop-1 additions: the deterministic link inventory is injected as a MUST-COVER
// checklist, the three-lane D37 classification is stated, the note-level lane names
// the note's own [[self-slug]] source, and the D36 no-fabrication guard is present.
// Mirrors the exact-substring style of stages.test.ts::buildFooter.
import { expect, test } from "bun:test";
import type { Block, Combo, LinkInventory } from "./text.ts";
import { extractComboPrompt, parseExtractResult } from "./prompts.ts";

const blocks: Block[] = [{ id: "B1", text: "Pragmatic first is reconnaissance for elegance." }];

const inventory: LinkInventory = {
  wikilinks: [
    {
      markup: "[[Not all shipped work looks the same]]",
      slug: "not-all-shipped-work-looks-the-same",
    },
    { markup: "[[Tech debt multiplied by AI]]", slug: "tech-debt-multiplied-by-ai" },
  ],
  external: [{ markup: "[Pólya](https://x.test/h)", text: "Pólya", url: "https://x.test/h" }],
};

test("extractComboPrompt: injects the inventory as a MUST-COVER checklist with each markup", () => {
  const p = extractComboPrompt(
    blocks,
    "",
    "en",
    inventory,
    "pragmatic-first-is-reconnaissance-for-elegance",
  );
  expect(p).toContain("LINK INVENTORY");
  expect(p).toContain("MUST-COVER");
  // every harvested wikilink markup appears verbatim in the checklist
  expect(p).toContain("[[Not all shipped work looks the same]]");
  expect(p).toContain("[[Tech debt multiplied by AI]]");
  // the external link rides a SEPARATE citation lane, never a vault relation
  expect(p).toContain("EXTERNAL LINKS");
  expect(p).toContain("[Pólya](https://x.test/h)");
});

test("extractComboPrompt: states the three-lane D37 classification and the D36 guard", () => {
  const p = extractComboPrompt(
    blocks,
    "",
    "en",
    inventory,
    "pragmatic-first-is-reconnaissance-for-elegance",
  );
  expect(p).toContain("TERM-SCOPED edge");
  expect(p).toContain("NOTE-LEVEL edge");
  expect(p).toContain("SEE-ALSO");
  // note-level lane names the note's own slug as the source endpoint
  expect(p).toContain(
    "SELF: this note's own slug is [[pragmatic-first-is-reconnaissance-for-elegance]]",
  );
  // D36 no-fabrication guard, load-bearing
  expect(p).toContain('NEVER fabricate a "rel"');
  expect(p).toContain("audit trail");
});

test("extractComboPrompt: the note-level lane is permanently demoted to see-also", () => {
  // the fabricating note-level channel is gone; every hostless link is a SEE-ALSO and
  // the emit-only instruction is never present.
  const p = extractComboPrompt(blocks, "", "en", inventory, "self-slug-here");
  expect(p).toContain("UNAVAILABLE for this note");
  expect(p).toContain("treat every hostless link as SEE-ALSO");
  expect(p).not.toContain("The note's own slug is the implicit source endpoint");
  expect(p).not.toContain('"from"'); // no per-edge from field in this data model
});

test("extractComboPrompt: a link-free note keeps the lean prompt (no inventory checklist)", () => {
  const p = extractComboPrompt(blocks, "", "en");
  // the checklist section and its SELF anchor are absent for a link-free note.
  expect(p).not.toContain("MUST-COVER");
  expect(p).not.toContain("SELF: this note's own slug");
  expect(p).not.toContain("TERM-SCOPED edge");
});

test("extractComboPrompt: the typed schema asks for title, abstract, judgements, inferences, and verbatim quotes", () => {
  const p = extractComboPrompt(blocks, "", "en");
  // the four new channels the typed extract emits
  expect(p).toContain('- "title"');
  expect(p).toContain('- "abstract"');
  expect(p).toContain('- "judgements"');
  expect(p).toContain('- "inferences"');
  // the verbatim-quote contract + the no-type-field rule (type = which array)
  expect(p).toContain("QUOTES:");
  expect(p).toContain("copied EXACTLY");
  expect(p).toContain('never emit a "type" field');
  // modality is tagged ONLY on judgements
  expect(p).toContain('"modality"');
  // the return schema carries a quote on every unit + relation
  expect(p).toContain(
    'Return ONLY JSON {"title":"...","abstract":"...","description":"...","thesis":"...","glossary":[{"term":"...","def":"...","quote":"...","relations":[{"rel":"...","to":"...","predicate":null,"quote":"..."}],"source":["Bn"]}],"judgements":[{"statement":"...","modality":null,"quote":"...","source":["Bn"]}],"inferences":[{"statement":"...","quote":"...","source":["Bn"]}],"workflow":[{"step":"...","quote":"...","source":["Bn"]}]}.',
  );
});

// ---- parseExtractResult: the pure normalization core (no network round-trip) ----
const parseBlocks: Block[] = [
  { id: "B1", text: "block one" },
  { id: "B2", text: "block two" },
];

// A raw model JSON fixture carrying typographic glyphs a quote must NOT be normalized
// against: curly quotes (“ ”), a tight em-dash (a—b), and an ellipsis (…). If a quote were
// run through normalizeTypography these would become straight quotes, " — ", and "...".
const CURLY = "he said “stop” now";
const TIGHT_EMDASH = "cause—effect chain";
const rawFixture = {
  title: "The Note Title",
  abstract: "A one-line orientation to the subject.",
  description: "model description",
  thesis: "the spine claim",
  glossary: [
    {
      term: "Alpha",
      def: "first concept",
      quote: CURLY,
      relations: [{ rel: "subsumes", to: "beta", predicate: null, quote: TIGHT_EMDASH }],
      source: ["B1", "B9"], // B9 is unknown — filtered out, B1 kept
    },
    {
      term: "Ghost",
      def: "only cited to a missing block",
      quote: "n/a",
      relations: [],
      source: ["B9"], // no valid source — the whole entry is dropped
    },
  ],
  judgements: [
    {
      statement: "X is necessarily Y",
      modality: "necessarily",
      quote: "must hold",
      source: ["B1"],
    },
    { statement: "maybe Z", modality: "guess", quote: "perhaps", source: ["B2"] }, // bad modality → null
    { statement: "unanchored", modality: null, quote: "q", source: ["B9"] }, // dropped, no source
  ],
  inferences: [
    { statement: "therefore W", quote: "so W follows", source: ["B2"] },
    { statement: "dangling", quote: "x", source: ["Bx"] }, // dropped, no source
  ],
  workflow: [
    { step: "do the thing", quote: "do it verbatim", source: ["B2"] },
    { step: "orphan step", quote: "y", source: ["B7"] }, // dropped, no source
  ],
} as unknown as Combo;

test("parseExtractResult: threads verbatim quotes onto entries, relations, and steps without typography normalization", () => {
  const out = parseExtractResult(rawFixture, parseBlocks);
  const alpha = out.glossary.find((e) => e.term === "Alpha")!;
  expect(alpha.quote).toBe(CURLY); // curly quotes untouched — byte-verbatim
  expect(alpha.relations[0].quote).toBe(TIGHT_EMDASH); // tight em-dash NOT spaced
  expect(out.workflow[0].quote).toBe("do it verbatim");
  // rel/to ARE normalized (they are the structural channel), only quote stays verbatim
  expect(alpha.relations[0].rel).toBe("subsumes");
  expect(alpha.relations[0].to).toBe("beta");
});

test("parseExtractResult: parses the judgement and inference channels with modality mapping", () => {
  const out = parseExtractResult(rawFixture, parseBlocks);
  // the unanchored judgement (source ["B9"]) is dropped; the two with valid sources survive
  expect(out.judgements).toHaveLength(2);
  expect(out.judgements![0].statement).toBe("X is necessarily Y");
  expect(out.judgements![0].modality).toBe("necessarily");
  expect(out.judgements![0].quote).toBe("must hold");
  expect(out.judgements![1].modality).toBeNull(); // bad "guess" modality → assertoric
  expect(out.inferences).toHaveLength(1); // the dangling one is dropped
  expect(out.inferences![0].statement).toBe("therefore W");
  expect(out.inferences![0].quote).toBe("so W follows");
});

test("parseExtractResult: an unknown modality string degrades to assertoric (null)", () => {
  // feed a fixture whose only judgement carries a bad modality but a valid source, so it survives
  const raw = {
    thesis: "t",
    glossary: [],
    workflow: [],
    judgements: [{ statement: "maybe Z", modality: "guess", quote: "perhaps", source: ["B2"] }],
    inferences: [],
  } as unknown as Combo;
  const out = parseExtractResult(raw, parseBlocks);
  expect(out.judgements).toHaveLength(1);
  expect(out.judgements![0].modality).toBeNull();
});

test("parseExtractResult: carries title and abstract through", () => {
  const out = parseExtractResult(rawFixture, parseBlocks);
  expect(out.title).toBe("The Note Title");
  expect(out.abstract).toBe("A one-line orientation to the subject.");
});

test("parseExtractResult: filters bad/unknown source block-ids and drops units left without a source", () => {
  const out = parseExtractResult(rawFixture, parseBlocks);
  // the Ghost entry (source ["B9"]) is dropped entirely
  expect(out.glossary.map((e) => e.term)).toEqual(["Alpha"]);
  // the surviving entry keeps only the valid id from ["B1","B9"]
  expect(out.glossary[0].source).toEqual(["B1"]);
});

test("parseExtractResult: an authored frontDescription overrides the model's", () => {
  const out = parseExtractResult(rawFixture, parseBlocks, "authored desc");
  expect(out.description).toBe("authored desc");
  const out2 = parseExtractResult(rawFixture, parseBlocks);
  expect(out2.description).toBe("model description");
});
