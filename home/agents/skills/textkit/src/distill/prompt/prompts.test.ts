// prompt-builder tests — run with `bun test` from this directory.
//
// extractGraphPrompt is a pure string builder (no model call). This suite pins the
// deterministic link-inventory injection (linkInventorySection, shared by the canonical
// extract prompt): the inventory is a MUST-COVER checklist, the three-lane classification
// is stated, the note-level lane names the note's own [[self-slug]] source, and the
// no-fabrication guard is present. It also pins the typed pre-graph schema the prompt asks
// for. parseExtractGraph (the pure normalizer) is covered by extract-graph.test.ts.
import { expect, test } from "bun:test";
import type { askJson } from "@/core/fw.ts";
import type { Block, LinkInventory } from "@/core/text.ts";
import { extractGraphPrompt, fidelityGate, renderEntryPrompt } from "@/distill/prompt/prompts.ts";

const blocks: Block[] = [{ id: "B1", text: "Pragmatic first is reconnaissance for elegance." }];

const inventory: LinkInventory = {
  wikilinks: [
    {
      markup: "[[Not all shipped work looks the same]]",
      slug: "not-all-shipped-work-looks-the-same",
      target: "Not all shipped work looks the same",
    },
    {
      markup: "[[Tech debt multiplied by AI]]",
      slug: "tech-debt-multiplied-by-ai",
      target: "Tech debt multiplied by AI",
    },
  ],
  external: [{ markup: "[Pólya](https://x.test/h)", text: "Pólya", url: "https://x.test/h" }],
};

test("extractGraphPrompt: injects the inventory as a MUST-COVER checklist with each markup", () => {
  const p = extractGraphPrompt(
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

test("extractGraphPrompt: states the three-lane classification and the no-fabrication guard", () => {
  const p = extractGraphPrompt(
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
  // no-fabrication guard, load-bearing
  expect(p).toContain('NEVER fabricate a "rel"');
  expect(p).toContain("audit trail");
});

test("extractGraphPrompt: the note-level lane is permanently demoted to see-also", () => {
  // the fabricating note-level channel is gone; every hostless link is a SEE-ALSO and
  // the emit-only instruction is never present.
  const p = extractGraphPrompt(blocks, "", "en", inventory, "self-slug-here");
  expect(p).toContain("UNAVAILABLE for this note");
  expect(p).toContain("treat every hostless link as SEE-ALSO");
  expect(p).not.toContain("The note's own slug is the implicit source endpoint");
  expect(p).not.toContain('"from"'); // no per-edge from field in this data model
});

test("extractGraphPrompt: a link-free note keeps the lean prompt (no inventory checklist)", () => {
  const p = extractGraphPrompt(blocks, "", "en");
  // the checklist section and its SELF anchor are absent for a link-free note.
  expect(p).not.toContain("MUST-COVER");
  expect(p).not.toContain("SELF: this note's own slug");
  expect(p).not.toContain("TERM-SCOPED edge");
});

test("extractGraphPrompt: the typed pre-graph schema asks for the five channels and verbatim quotes", () => {
  const p = extractGraphPrompt(blocks, "", "en");
  // the document-level orientation fields + the two claim channels
  expect(p).toContain('- "title"');
  expect(p).toContain('- "abstract"');
  expect(p).toContain('- "judgements"');
  expect(p).toContain('- "inferences"');
  // the canonical channels: concepts (headword/statement) and grouped procedures
  expect(p).toContain('- "concepts"');
  expect(p).toContain('"headword"');
  expect(p).toContain('"statement"');
  expect(p).toContain('- "procedures"');
  // the verbatim-quote contract + the no-type-field rule (type = which array)
  expect(p).toContain("QUOTES:");
  expect(p).toContain("copied EXACTLY");
  expect(p).toContain('never emit a "type" field');
  // modality is tagged ONLY on judgements
  expect(p).toContain('"modality"');
  // the return schema carries a quote on every unit + relation; relations drop `predicate`
  expect(p).toContain(
    'Return ONLY JSON {"title":"...","abstract":"...","description":"...","thesis":"...","concepts":[{"headword":"...","statement":"...","quote":"...","bullets":[{"statement":"...","quote":"..."}],"relations":[{"rel":"...","to":"...","quote":"..."}],"source":["Bn"]}],"judgements":[{"statement":"...","modality":null|"hypothesis"|"necessarily","quote":"...","source":["Bn"]}],"inferences":[{"statement":"...","quote":"...","source":["Bn"]}],"procedures":[{"headword":"...","steps":[{"statement":"...","quote":"...","source":["Bn"]}]}]}.',
  );
  expect(p).not.toContain('"predicate"'); // predicate dropped from relations
});

test("extractGraphPrompt: the concept schema asks for an optional extension-bullets array (per-bullet spans)", () => {
  const p = extractGraphPrompt(blocks, "", "en");
  // the extension surface: a per-concept bullets array carrying its own verbatim quote
  expect(p).toContain('"bullets"');
  expect(p).toContain("EXTENSION");
  expect(p).toContain("predicated properties or enumerated species");
  // guarded against fabrication, like the relations lane
  expect(p).toContain("do NOT invent a bullet the note does not state");
});

// ---- def-scope experiment levers: DI seams over the DISTILL_DEF_RELATIONS /
// DISTILL_DEF_GATE env reads. Each lever now threads as a trailing param
// defaulting to the module-level env value, so a caller can flip it without
// process-global env mutation. These pin that the param — not just the env var —
// actually changes the prompt text.
test("renderEntryPrompt: the defRelations param overrides the env-derived default", () => {
  const dropDefault = renderEntryPrompt({ term: "x", def: "" }, "source text", "en");
  expect(dropDefault).toContain("state no relations to other terms");
  const kept = renderEntryPrompt({ term: "x", def: "" }, "source text", "en", "keep");
  expect(kept).toContain("keep every relation the source states");
  expect(kept).not.toContain("state no relations to other terms");
});

test("fidelityGate: the defGate param overrides the env-derived default", async () => {
  let seenPrompt = "";
  const captureAsk = (async (_model: string, prompt: string) => {
    seenPrompt = prompt;
    return { thesisRecoverable: true, concepts: [] };
  }) as typeof askJson;
  const rendered = [{ term: "x", def: "d", sourceText: "s" }];
  await fidelityGate("thesis", "body", rendered, captureAsk); // default lever: "definition"
  expect(seenPrompt).toContain("The OUTPUT is a DEFINITION of the concept");
  // def mode cites GROUNDING, not coverage: the translated-citation clause must ask for the
  // span that grounds the definitional claim and NOT for "the span the OUTPUT renders" — the
  // coverage framing that flipped faithful partial defs to residue (Backlog 23 recheck).
  expect(seenPrompt).toContain("GROUNDS its definitional claim");
  expect(seenPrompt).not.toContain("the span the OUTPUT faithfully renders");
  await fidelityGate("thesis", "body", rendered, captureAsk, "block");
  expect(seenPrompt).toContain("Decide round-trip entailment in BOTH directions");
  // block mode keeps the prior coverage citation wording byte-for-byte.
  expect(seenPrompt).toContain("the span the OUTPUT faithfully renders");
});
