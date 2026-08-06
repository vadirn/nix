// writing/verify — the deterministic check that a masked-block rewrite kept a
// change-nothing-else contract. It lives in core/writing so every writing CLI shares
// one verifier, not a per-tool copy. Four axes, checked in order; the first failure
// names the reason. A caller reverts a failing block to its input, so a false positive
// loses a correction, never meaning.
import { masksSurvived } from "textkit/core/writing/mask.ts";
import { levenshtein, levenshteinBounded } from "textkit/core/writing/levenshtein.ts";

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
  if (!masksSurvived(input, output)) return { ok: false, reason: "mask tokens changed" };
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
