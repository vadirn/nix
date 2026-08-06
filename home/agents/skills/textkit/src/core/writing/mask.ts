// writing/mask — the ⟦N⟧ masking engine shared by revise() and spellPass(): freeze
// reference spans (and caller-supplied literal spans) to opaque tokens the writing
// model cannot reword or drop, then restore them verbatim after the rewrite.
import { MASK_RE } from "textkit/core/text.ts";

// Matches a single ⟦N⟧ mask token (the numbered placeholder createMasker mints), e.g. "⟦3⟧".
// Exported so spell.ts's verify step can multiset-compare mask tokens between input and
// output.
export const MASK_TOKEN_RE = /⟦\d+⟧/g;

// masksSurvived reports whether `output` carries exactly the same multiset of ⟦N⟧ tokens as
// `input` — every reference span present the same number of times, none dropped, duplicated, or
// invented. This is the ONE mask-survival mechanism: verifySpellBlock uses it as its first axis
// (a change-nothing-else pass), and the simplify guard uses it alone (a heavy restyle changes
// line count and diff size by design, so only mask-survival transfers). Total: never throws.
export function masksSurvived(input: string, output: string): boolean {
  const a = (input.match(MASK_TOKEN_RE) ?? []).sort();
  const b = (output.match(MASK_TOKEN_RE) ?? []).sort();
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

// A Masker pairs the mask/unmask functions built by one createMasker() call: mask() replaces
// reference spans (and that call's literals) with opaque ⟦N⟧ tokens, and unmask() restores the
// original text from those tokens. The two share state (the token map) and must be called as
// a pair from the same createMasker() instance.
export type Masker = {
  mask(text: string): string;
  unmask(text: string): string;
};

// createMasker builds a Masker: `literals` are exact spans frozen first (longest-first, so a
// containing span masks whole before its substring), then MASK_RE spans ([[wikilinks]],
// ![[embeds]], inline code). Token numbering is per-factory-call, monotonically increasing. A
// ⟦N⟧ span already present in the incoming text (a note documenting the mask engine itself) is
// frozen first to a fresh minted token mapping back to the literal, so every token in masked
// text is minted here, and unmask can never rewrite a pre-existing literal into another span's
// content.
export function createMasker(literals: string[] = []): Masker {
  const masks = new Map<string, string>();
  const litToken = new Map<string, string>();
  let n = 0;
  const orderedLiterals = [...new Set(literals.filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  const maskLiterals = (text: string): string => {
    let out = text;
    for (const lit of orderedLiterals) {
      if (!out.includes(lit)) continue;
      let key = litToken.get(lit);
      if (!key) {
        key = `⟦${n++}⟧`;
        litToken.set(lit, key);
        masks.set(key, lit);
      }
      out = out.split(lit).join(key);
    }
    return out;
  };
  // Runs before literal/reference masking, so a freshly minted key never collides with a
  // span the source text spelled out itself.
  const freezeExistingTokens = (text: string): string =>
    text.replace(MASK_TOKEN_RE, (m) => {
      const key = `⟦${n++}⟧`;
      masks.set(key, m);
      return key;
    });
  const mask = (text: string): string =>
    maskLiterals(freezeExistingTokens(text)).replace(MASK_RE, (m) => {
      const key = `⟦${n++}⟧`;
      masks.set(key, m);
      return key;
    });
  const unmask = (text: string): string =>
    masks.size === 0 ? text : text.replace(MASK_TOKEN_RE, (m) => masks.get(m) ?? m);
  return { mask, unmask };
}
