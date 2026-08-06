// writing/spell — the spell/grammar pass: one rewrite on EXTRACT under a
// change-nothing-else contract, verified deterministically per block. A block whose
// candidate fails verification ships as its input, so the pass can only lose a
// correction, never meaning. Consumed only by polish.ts — distill's pipeline does
// not gain a spell stage.
import { type Block, render } from "textkit/core/text.ts";
import { askJson } from "@skills/llm/llm.ts";
import { polishDegrade as rethrowIfBug } from "textkit/core/degrade.ts";
import { POLISH_MODEL, POLISH_TOKENS } from "textkit/core/models.ts";
import { createMasker } from "textkit/core/writing/mask.ts";
import { makeIdMarkerStripper } from "textkit/core/writing/passes.ts";
import { verifySpellBlock } from "textkit/core/writing/verify.ts";
import { normalizeTypography } from "textkit/core/typography.ts";

// spellPassPrompt builds the proofreader prompt for one spellPass call: fix only spelling,
// typo, and grammatical-agreement errors, changing nothing else. No langRule() here: that
// rule is written for abstractive generation and instructs the model to WRITE in the note's
// language, which on code-switched (mixed RU/EN) notes reads as an order to translate the
// other language's clauses — observed live, small translations fit inside the 15% diff bound.
// A proofreader must never translate, so the prompt is language-neutral and takes no lang
// param.
export function spellPassPrompt(blocks: Block[]): string {
  return `You are a proofreader. Fix ONLY objective spelling, typo, and grammatical-agreement errors in each block below: misspelled words, wrong case/number/gender/tense agreement, misused homophones, and incorrect compound spelling (e.g. "in stead" vs "instead"). Change NOTHING else: no rephrasing, no reordering, no synonym substitutions, no added or removed words beyond the minimal correction, no punctuation-style changes. Keep every word in the language it is written in; never translate. Keep every line break, heading, list marker, and table cell exactly where it is. Keep code blocks verbatim, and reproduce any ⟦N⟧ placeholder tokens unchanged, exactly as many times as they appear. Preserve emphasis (**bold**, _italic_). If a block has no errors, return its text unchanged. Return ONLY JSON {"blocks":[{"id":"B1","text":"corrected text"}, ...]} — one entry per block, ids matching.

TEXT:
${render(blocks)}`;
}

// spellPass runs spellPassPrompt once over `blocks`, verifies each returned block with
// verifySpellBlock, and reverts any block that fails verification to its original text (never
// meaning-losing, only correction-losing). Returns the resulting blocks, the ids of any
// reverted blocks, and `failed: true` on a transient/parse error (in which case `blocks` is
// the unchanged input and `reverted` is empty).
export async function spellPass(
  blocks: Block[],
  // Exact spans to freeze alongside the reference spans (as in revise's `literals`);
  // production polish passes [] since it runs no glossary term list.
  literals: string[] = [],
  // The model call, injected so tests drive a flake / revert case without a
  // process-global module mock; production callers omit it for the real transport.
  ask: typeof askJson = askJson,
): Promise<{ blocks: Block[]; reverted: string[]; failed: boolean }> {
  // Same masking engine as revise() in passes.ts: reference spans are frozen to ⟦N⟧
  // tokens the model cannot reword, restored verbatim at the end.
  const { mask, unmask } = createMasker(literals);
  const stripIdMarkers = makeIdMarkerStripper(blocks);
  const masked = blocks.map((b) => ({ id: b.id, text: mask(b.text) }));
  const reverted: string[] = [];
  let cur = masked;
  try {
    const { blocks: fixed } = await ask<{ blocks: { id: string; text: string }[] }>(
      POLISH_MODEL,
      spellPassPrompt(masked),
      POLISH_TOKENS,
    );
    const byId = new Map(fixed.map((r) => [r.id, r.text]));
    cur = masked.map((b) => {
      const t = byId.get(b.id);
      if (t == null) return b; // dropped by the model: keep the input (revise idiom)
      const candidate = stripIdMarkers(t);
      if (!verifySpellBlock(b.text, candidate).ok) {
        reverted.push(b.id);
        return b;
      }
      return { id: b.id, text: candidate };
    });
  } catch (e) {
    rethrowIfBug(e, "spell");
    // transient/truncation: the caller reports "spell pass failed"; input unchanged
    return { blocks, reverted: [], failed: true };
  }
  return {
    blocks: cur.map((b) => ({ id: b.id, text: unmask(normalizeTypography(b.text)) })),
    reverted,
    failed: false,
  };
}
