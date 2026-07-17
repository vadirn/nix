// normalize-citation — the GENTLE fold the citation substring-check normalizes both sides
// through before asking "is the judge's cited evidence a literal span of the source block?".
// It is deliberately gentler than snap.ts's `normalizeForSnap`: that fold collapses EVERY
// non-alphanumeric run to a space, which erases the very punctuation a numeric or symbolic
// distortion lives in (a "10ms"->"50ms" swap, an inserted "not") — so it would let a
// punctuation-blind match pass and wash out exactly the distortions this check exists to catch.
// This fold instead strips only markdown MARKUP (link/wikilink wrappers, fence lines, list and
// blockquote and heading markers, inline emphasis/code glyphs), folds smart quotes and case,
// and collapses whitespace — leaving PROSE PUNCTUATION (. ; : ! ? — ( ) / ≠ …) intact. Ported
// verbatim from the Backlog-23 exactness probe's `gentle` variant, the variant that tied
// `normalizeForSnap`'s 100% faithful-translated match rate while preserving that punctuation.
//
// Pure string→string: no I/O and no mdstruct-alias import, so it stays free of snap's parse
// chain and can normalize a raw evidence string and a raw source block symmetrically.

// Fold a citation string to the gentle comparison key. Per-line so the leading-indent strip only
// eats a line's own indentation (tolerating the ragged leading whitespace of a mid-indent source
// block, e.g. the Docker gold-set pf4/pi2 blocks) rather than swallowing interior structure; the
// former newlines then collapse into the final single-space whitespace run.
export function normalizeCitation(s: string): string {
  return s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // [text](url) / ![alt](url) -> text/alt
    .replace(/!?\[\[([^\]]*)\]\]/g, "$1") // [[wikilink]] / ![[embed]] -> inner text
    .replace(/```[^\n]*/g, " ") // fenced-code fence lines (markup, not content)
    .split("\n")
    .map(
      (line) =>
        line
          .replace(/^\s+/, "") // leading indent / hard-wrap indentation
          .replace(/^>+\s?/, "") // blockquote marker
          .replace(/^#{1,6}\s+/, "") // heading marker
          .replace(/^\d+[.)]\s+/, "") // ordered list marker "1. " / "1) "
          .replace(/^[-*+]\s+/, ""), // bullet marker "- " / "* " / "+ "
    )
    .join(" ")
    .replace(/[*_`~]+/g, "") // inline emphasis / inline-code markers (markup, not content)
    .replace(/[‘’‚‛]/g, "'") // smart single quotes -> '
    .replace(/[“”„‟]/g, '"') // smart double quotes -> "
    .replace(/\s+/g, " ") // collapse all whitespace (incl. former newlines)
    .toLowerCase()
    .trim();
}
