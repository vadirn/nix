// writing/mask tests — pre-existing literal ⟦N⟧ spans in the source text survive
// the mask/unmask round-trip: mask() freezes them to fresh minted tokens first, so
// every token in masked text is minted by this factory and unmask can never rewrite
// a literal the source spelled out into another span's content.
import { expect, test } from "bun:test";
import { createMasker } from "@/core/writing/mask.ts";

test("createMasker: a literal ⟦0⟧ in the text survives the round-trip beside a masked span", () => {
  const m = createMasker();
  const src = "The masker mints ⟦0⟧ tokens; see [[mask engine]] for details.";
  const masked = m.mask(src);
  expect(masked).not.toContain("[[mask engine]]");
  expect(m.unmask(masked)).toBe(src);
});

test("createMasker: a literal token in a later block never aliases an earlier mint", () => {
  const m = createMasker();
  const b1 = m.mask("see [[mask engine]]"); // mints a token for the wikilink
  const b2 = m.mask("the literal ⟦0⟧ stays literal");
  expect(m.unmask(b1)).toBe("see [[mask engine]]");
  expect(m.unmask(b2)).toBe("the literal ⟦0⟧ stays literal");
});
