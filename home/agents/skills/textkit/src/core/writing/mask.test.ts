// writing/mask tests — two properties of the ⟦N⟧ engine. (1) Pre-existing literal ⟦N⟧
// spans in the source text survive the mask/unmask round-trip: mask() freezes them to
// fresh minted tokens first, so every token in masked text is minted by this factory and
// unmask can never rewrite a literal the source spelled out into another span's content.
// (2) An HTML comment is an atom like a wikilink — masked whole, restored byte-identical.
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

// ---- HTML comments are atoms: masked whole, restored byte-identical ----
// The measured defect: a restyle rewrote a ticket template's comment, turning the coined
// `repo-self-sufficient` into plain `self-sufficient` and dropping the qualifier that carried the
// condition. Masking makes the comment opaque, so the restyle never sees text to reword.
test("createMasker: an HTML comment round-trips byte-identical, masked whole", () => {
  const m = createMasker();
  const comment =
    "<!-- Body stays repo-self-sufficient: keep [[wikilinks]] and vault-entry references to the frontmatter. -->";
  const src = `# Ticket\n\n${comment}\n\nSome prose here.`;
  const masked = m.mask(src);
  // Not one word of the comment reaches the model — including the wikilink nested inside it,
  // which masks as part of the comment rather than being carved out as its own span.
  expect(masked).not.toContain("repo-self-sufficient");
  expect(masked).not.toContain("[[wikilinks]]");
  expect(masked).toContain("⟦0⟧");
  expect(masked).toContain("Some prose here."); // surrounding prose stays editable
  expect(m.unmask(masked)).toBe(src);
});

test("createMasker: a multi-line comment is one atom, and two on a line are two", () => {
  const m = createMasker();
  const src = "<!-- a -->x<!-- b -->\n\n<!--\nspans\nlines\n-->";
  const masked = m.mask(src);
  expect(masked).toBe("⟦0⟧x⟦1⟧\n\n⟦2⟧"); // lazy close: `-->` ends a comment, it never runs on
  expect(m.unmask(masked)).toBe(src);
});

test("createMasker: an unclosed `<!--` stays prose rather than swallowing the note", () => {
  const m = createMasker();
  const src = "a <!-- never closed, and the rest of the note follows";
  expect(m.mask(src)).toBe(src);
});

// ---- inline code follows CommonMark's matched-run rule ----
// The measured defect: the code-span spelling was a single-backtick pair. Against `` a`b `` it
// opened on the first backtick and closed on the inner one. So it froze the fragment ` a` and
// handed the model the rest of the span as editable prose.
test("createMasker: a double-backtick span masks whole, not as a fragment", () => {
  const m = createMasker();
  const src = "Text with `` a`b `` tail.";
  const masked = m.mask(src);
  expect(masked).toBe("Text with ⟦0⟧ tail."); // one atom, not a fragment plus loose prose
  expect(masked).not.toContain("`"); // no backtick survives as editable text
  expect(m.unmask(masked)).toBe(src);
});

// The closer is the first run of EXACTLY the opener's length, so a longer run inside the span is
// content. A closer-length test alone would end the span at the last two of the three backticks.
test("createMasker: a longer backtick run inside a span is content, not the closer", () => {
  const m = createMasker();
  const src = "Text with ``a ```b``` c`` tail.";
  const masked = m.mask(src);
  expect(masked).toBe("Text with ⟦0⟧ tail.");
  expect(m.unmask(masked)).toBe(src);
});

test("createMasker: a single-backtick span masks exactly as it did before", () => {
  const m = createMasker();
  const src = "Run `bun test src`, then read the `--help` line.";
  expect(m.mask(src)).toBe("Run ⟦0⟧, then read the ⟦1⟧ line.");
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
