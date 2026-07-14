// writing/spell — the spell/grammar pass: one rewrite on EXTRACT under a
// change-nothing-else contract, verified deterministically per block. A block whose
// candidate fails verification ships as its input, so the pass can only lose a
// correction, never meaning. Consumed only by polish.ts — distill's pipeline does
// not gain a spell stage.
import { type Block, render } from "../text.ts";
import { askJson, EXTRACT, EXTRACT_TOKENS, rethrowIfBug } from "../fw.ts";
import { MASK_TOKEN_RE, createMasker } from "./mask.ts";
import { levenshtein, levenshteinBounded } from "./levenshtein.ts";
import { makeIdMarkerStripper } from "./passes.ts";
import { normalizeTypography } from "./typography.ts";

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

// Deterministic verification on the MASKED text, in this order; the first failure
// names the reason. (1) mask-token multiset equality — every ⟦N⟧ present exactly as
// often as in input; (2) line-count equality; (3) bounded diff — character-level
// Levenshtein within 15% of the input, absolute floor 4 so a one-word block can
// still be corrected; (4) word-level replacement distance — every output word absent
// from the input must sit within Levenshtein 2 of some input word: a spelling fix
// stays close to the misspelling, a synonym substitution does not (observed live:
// "bruited" → "broadcast" shipped inside the 15% bound). A false positive here only
// reverts a block to its input, losing a correction, never meaning.
const wordsOf = (s: string): string[] => s.toLowerCase().match(/[\p{L}][\p{L}'’]*/gu) ?? [];
export function verifySpellBlock(input: string, output: string): { ok: boolean; reason?: string } {
  const inTokens = (input.match(MASK_TOKEN_RE) ?? []).sort();
  const outTokens = (output.match(MASK_TOKEN_RE) ?? []).sort();
  if (inTokens.length !== outTokens.length || inTokens.some((t, i) => t !== outTokens[i]))
    return { ok: false, reason: "mask tokens changed" };
  if (input.split("\n").length !== output.split("\n").length)
    return { ok: false, reason: "line structure changed" };
  // bounded variant: the full DP on a 20k-char block costs seconds; the verify
  // only needs "within bound or not", never the exact distance beyond it
  const bound = Math.max(4, Math.ceil(0.15 * input.length));
  if (levenshteinBounded(input, output, bound) > bound)
    return { ok: false, reason: "diff exceeds bound" };
  const inWords = new Set(wordsOf(input));
  for (const w of new Set(wordsOf(output))) {
    if (inWords.has(w)) continue;
    let close = false;
    for (const iw of inWords) {
      if (Math.abs(iw.length - w.length) > 2) continue;
      if (levenshtein(w, iw) <= 2) {
        close = true;
        break;
      }
    }
    if (!close) return { ok: false, reason: "word replaced beyond spelling distance" };
  }
  return { ok: true };
}

// spellPass runs spellPassPrompt once over `blocks`, verifies each returned block with
// verifySpellBlock, and reverts any block that fails verification to its original text (never
// meaning-losing, only correction-losing). Returns the resulting blocks, the ids of any
// reverted blocks, and `failed: true` on a transient/parse error (in which case `blocks` is
// the unchanged input and `reverted` is empty).
export async function spellPass(
  blocks: Block[],
  literals: string[] = [],
  // The model call, injected so tests drive a flake / revert case without a
  // process-global module mock; production callers omit it for the real fw transport.
  ask: typeof askJson = askJson,
): Promise<{ blocks: Block[]; reverted: string[]; failed: boolean }> {
  // Same masking engine as revise() in passes.ts: reference spans (and caller literals) are
  // frozen to ⟦N⟧ tokens the model cannot reword, restored verbatim at the end.
  const { mask, unmask } = createMasker(literals);
  const stripIdMarkers = makeIdMarkerStripper(blocks);
  const masked = blocks.map((b) => ({ id: b.id, text: mask(b.text) }));
  const reverted: string[] = [];
  let cur = masked;
  try {
    const { blocks: fixed } = await ask<{ blocks: { id: string; text: string }[] }>(
      EXTRACT,
      spellPassPrompt(masked),
      EXTRACT_TOKENS,
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
