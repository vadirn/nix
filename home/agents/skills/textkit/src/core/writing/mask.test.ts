// writing/mask tests — pre-existing literal ⟦N⟧ spans in the source text survive
// the mask/unmask round-trip: mask() freezes them to fresh minted tokens first, so
// every token in masked text is minted by this factory and unmask can never rewrite
// a literal the source spelled out into another span's content.
import { expect, test } from "bun:test";
import { createMasker, masksSurvived } from "textkit/core/writing/mask.ts";

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

// ---- masksSurvived: mask-token multiset equality (the shared survival mechanism) ----
test("masksSurvived: an identical token multiset survives a heavy reword around it", () => {
  // simplify rewrites prose freely; only the ⟦N⟧ spans must be reproduced unchanged.
  expect(masksSurvived("run ⟦0⟧ then ⟦1⟧ twice", "⟦1⟧ and ⟦0⟧ — reordered, reworded")).toBe(true);
});

test("masksSurvived: a dropped token fails", () => {
  expect(masksSurvived("keep ⟦0⟧ and ⟦1⟧", "keep only ⟦0⟧")).toBe(false);
});

test("masksSurvived: a duplicated token fails", () => {
  expect(masksSurvived("one ⟦0⟧", "⟦0⟧ and ⟦0⟧ again")).toBe(false);
});

test("masksSurvived: token-free input and output both survive", () => {
  expect(masksSurvived("plain prose in", "plain prose out")).toBe(true);
});
