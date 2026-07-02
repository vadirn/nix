// writing/mask — the ⟦N⟧ masking engine shared by revise() and spellPass(): freeze
// reference spans (and caller-supplied literal spans) to opaque tokens the writing
// model cannot reword or drop, then restore them verbatim after the rewrite.
import { MASK_RE } from "../text.ts";

export const MASK_TOKEN_RE = /⟦\d+⟧/g;

export type Masker = {
  mask(text: string): string;
  unmask(text: string): string;
};

// literals: exact spans frozen first (longest-first so a containing span masks
// whole before its substring); then MASK_RE spans ([[wikilinks]], ![[embeds]],
// inline code). Token numbering is per-factory-call, monotonically increasing.
// A ⟦N⟧ span already present in the incoming text (a note documenting the mask
// engine itself) is frozen first to a fresh minted token mapping back to the
// literal, so every token in masked text is minted here and unmask can never
// rewrite a pre-existing literal into another span's content.
export function createMasker(literals: string[] = []): Masker {
  const masks = new Map<string, string>();
  const litToken = new Map<string, string>();
  let n = 0;
  // freeze the literal spans first (longest first, so a term that contains another
  // is masked whole before its substring), then the reference-span regex.
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
  // freeze pre-existing ⟦N⟧ literals to fresh tokens BEFORE literal/reference
  // masking, so a minted key never collides with (or gets confused for) a span
  // the source text spelled out itself.
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
    masks.size === 0 ? text : text.replace(/⟦\d+⟧/g, (m) => masks.get(m) ?? m);
  return { mask, unmask };
}
