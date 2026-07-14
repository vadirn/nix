// writing/typography — deterministic typographic normalization. Leaf module:
// imports nothing, so the core can depend on it without a cycle back to text.ts.

// normalizeTypography maps typeset glyphs the revise model substitutes back to their plain
// equivalents (curly quotes, a non-breaking hyphen) regardless of prompt instruction. Em
// dashes (—) are kept as clause breaks (the source notes use them) but normalized to spaced
// form ( — ), since the model emits them tight (model—assuming) about half the time. It
// touches only those substitutes — Cyrillic and source guillemets are left alone, safe for RU.
export function normalizeTypography(s: string): string {
  return s
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–]/g, "-") // hyphen/nbhyphen/figure/en (ranges) → bare - (em dash — is kept)
    .replace(/[ \t]*[—―][ \t]*/g, " — ") // em dash / bar → spaced em dash; never eats a newline
    .replace(/…/g, "...")
    .replace(/ /g, " "); // nbsp → space
}
