// simplify/prompt tests — the restyle prompt is frozen: the language-selected ruleset, the
// keep-verbatim and no-op clauses, the never-translate guard, and the strict seven-key JSON schema
// are all pinned. Pure, offline: no model call.
import { expect, test } from "bun:test";
import {
  BRIEF_KEYS,
  resolveLang,
  SIMPLIFY_RULESET_EN,
  SIMPLIFY_RULESET_RU,
  simplifyPrompt,
} from "textkit/simplify/prompt.ts";

test("simplifyPrompt: EN embeds the English ruleset, the schema, and the masked text", () => {
  const p = simplifyPrompt("A wordy ⟦0⟧ sentence.", "en");
  expect(p).toContain(SIMPLIFY_RULESET_EN);
  expect(p).not.toContain(SIMPLIFY_RULESET_RU);
  // the seven keys are all named in the JSON schema
  for (const k of BRIEF_KEYS) expect(p).toContain(`"${k}"`);
  // masked text is carried verbatim under a TEXT section
  expect(p).toContain("TEXT:\nA wordy ⟦0⟧ sentence.");
});

test("simplifyPrompt: RU swaps to the Russian ruleset, not a port of the English one", () => {
  const p = simplifyPrompt("Многословное ⟦0⟧ предложение.", "ru");
  expect(p).toContain(SIMPLIFY_RULESET_RU);
  expect(p).not.toContain(SIMPLIFY_RULESET_EN);
  // a Russian-specific mechanic the English rules never mention
  expect(p).toContain("«является»");
});

test("simplifyPrompt: the no-op clause and the never-translate guard are pinned in both languages", () => {
  for (const lang of ["en", "ru"] as const) {
    const p = simplifyPrompt("x ⟦0⟧ y", lang);
    // already-compliant text round-trips unchanged
    expect(p).toContain("If the text already satisfies every rule, change nothing");
    // a proofreader-style guard against translating code-switched clauses (polish's live-observed bug)
    expect(p).toContain("never translate");
    // reference spans are reproduced, not reworded
    expect(p).toContain("Reproduce every ⟦N⟧ placeholder token unchanged");
  }
});

test("simplifyPrompt: KEEP pins list kind, item count, split-within-item, and thematic breaks", () => {
  for (const lang of ["en", "ru"] as const) {
    const p = simplifyPrompt("x ⟦0⟧ y", lang);
    // the KEEP scaffolding is English and shared, so both languages carry the list guardrail
    expect(p).toContain("keep its kind (numbered stays numbered, bulleted stays bulleted)");
    expect(p).toContain("its item count");
    expect(p).toContain("Never promote a sentence to a new list item");
    expect(p).toContain("thematic breaks (a `---` separator line)");
  }
});

test("simplifyPrompt: SHAPE is scoped to prose so it never over-splits an existing list", () => {
  // the SHAPE rule builds a list only from PROSE; both rulesets scope it to avoid the over-split
  expect(SIMPLIFY_RULESET_EN).toContain("turn a PROSE sequence or set into a vertical list");
  expect(SIMPLIFY_RULESET_EN).toContain("keep an existing list's kind and item count");
  expect(SIMPLIFY_RULESET_RU).toContain("В ПРОЗЕ");
  expect(SIMPLIFY_RULESET_RU).toContain("сохрани вид и число пунктов");
});

test("resolveLang: auto-detects by script, and an explicit override wins", () => {
  expect(resolveLang("auto", "plain english prose here")).toBe("en");
  expect(resolveLang("auto", "обычный русский текст здесь")).toBe("ru");
  expect(resolveLang("ru", "english body")).toBe("ru"); // override beats detection
  expect(resolveLang("en", "русское тело")).toBe("en");
});
