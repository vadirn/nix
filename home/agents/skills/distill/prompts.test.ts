// prompt-builder tests — run with `bun test` from this directory.
//
// extractComboPrompt is a pure string builder (no model call). This suite pins the
// D38 Loop-1 additions: the deterministic link inventory is injected as a MUST-COVER
// checklist, the three-lane D37 classification is stated, the note-level lane names
// the note's own [[self-slug]] source, and the D36 no-fabrication guard is present.
// Mirrors the exact-substring style of stages.test.ts::buildFooter.
import { expect, test } from "bun:test";
import type { Block, LinkInventory } from "./text.ts";
import { extractComboPrompt } from "./prompts.ts";

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
