// snap.ts — the BLOCK-granular anchor primitive for idea-lane units. Where locate() demands a
// byte-exact quote and hard-gates on any drift, an idea unit is an ABSTRACTIVE compression: the
// model rewrites the source, so its `quote` is an APPROXIMATE pointer, not a verbatim slice. snap
// resolves that approximate quote to the enclosing mdstruct block and returns THAT block's span —
// coarser than locate's character span, but robust to the paraphrase, glyph-swap, and sentence-
// stitch a distilled quote carries. The fidelity contract stays typed-throw: a quote that shares
// no token with any block THROWS a SnapError rather than snapping to noise (mirroring locate's
// hard gate), and only an intentionally empty quote returns null (the no-anchor hole).
//
// It is a leaf over mdstruct.ts: it consumes an already-parsed `ParsedDoc` (the caller owns the
// parseDoc I/O), walks `doc.nodes` with `walkNodes`, and recovers block text with `sliceBytes`.
// It never spawns the binary itself and never validates edge `rel`.
import {
  sliceBytes,
  walkNodes,
  type MdNode,
  type ParsedDoc,
  type Span,
} from "@/distill/mdstruct.ts";

// The mdstruct node types that carry a snappable prose block. A distilled quote lives inside
// exactly one paragraph-grade block; `listItem`, `table`, `codeBlock`, and `blockQuote` are kept
// alongside `paragraph` so a quote lifted from any of them still has a target. These are mdstruct's
// actual camelCase node-type strings (the same literals harvest.ts matches on). Headings are NOT a
// snap target: mdstruct puts them in `doc.headings`, never in `doc.nodes` (what walkNodes traverses).
const KEEP: Set<string> = new Set(["paragraph", "codeBlock", "blockQuote", "listItem", "table"]);

// SnapError is the typed hard-gate failure snapQuote() throws when a non-empty quote scores zero
// against every target (no shared token) — the block-granular analogue of LocateError. `quote`
// carries the offending text for the error message.
export class SnapError extends Error {
  readonly quote: string;
  constructor(quote: string, message: string) {
    super(message);
    this.name = "SnapError";
    this.quote = quote;
  }
}

// One enumerable snap target per paragraph-grade block: its byte `span`, its normalized text
// `nText` (the CONTAINS comparison key), and `tokens` (nText's word split, the OVERLAP comparison
// key). Both are precomputed once per block so snapQuote never re-normalizes or re-tokenizes a
// block on each quote.
export type SnapTarget = { span: Span; nText: string; tokens: string[] };

// Normalize a string to the token-comparison key both the quote and every block reduce to before
// matching: flatten `[text](url)` / `![alt](url)` to the text/alt and `[[wikilink]]` / `![[embed]]`
// to the inner text, lowercase, then collapse every run of non-alphanumeric characters (Unicode-
// aware `\p{L}\p{N}`) to a single space — one fold that erases U+2011 non-breaking hyphens, curly
// quotes, and all punctuation at once — and trim. Two texts sharing the same words snap together
// regardless of the glyphs, links, or case the model swapped in.
export function normalizeForSnap(s: string): string {
  return s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // [text](url) / ![alt](url) -> text/alt
    .replace(/!?\[\[([^\]]*)\]\]/g, "$1") // [[wikilink]] / ![[embed]] -> inner text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ") // any non-alphanumeric run (incl. U+2011, punctuation) -> space
    .trim();
}

// Distinct-preserving token split of an already-normalized string (single-space separated).
function tokenize(nText: string): string[] {
  return nText.split(" ").filter(Boolean);
}

// Build the snap-target list from an already-parsed doc — PURE (no I/O; the caller ran parseDoc).
// Walks every node, keeps the paragraph-grade block types, recovers each block's text by byte span,
// skips blocks whose normalized text is empty, and carries span / nText / tokens.
export function buildSnapTargets(parsed: ParsedDoc): SnapTarget[] {
  const { doc, buf } = parsed;
  const out: SnapTarget[] = [];
  walkNodes(doc.nodes, (n: MdNode) => {
    if (!n.span || !KEEP.has(n.type)) return;
    const nText = normalizeForSnap(sliceBytes(buf, n.span));
    if (!nText) return; // block reduces to no tokens — nothing to snap against.
    out.push({ span: n.span, nText, tokens: tokenize(nText) });
  });
  return out;
}

// Snap `quote` to the block it was distilled from and return that block's span, a confidence
// `score`, and `how` it resolved. CONTAINS first: prefer a block whose normalized text contains
// the whole normalized quote (`how: "contains"`, `score: 1`); on several containers, tie-break to
// the shortest nText — the tightest enclosure. OVERLAP fallback: otherwise the block with the
// maximal count of distinct quote-tokens present, scored as `shared / quoteTokenCount`
// (`how: "overlap"`).
//
// Miss contract (mirrors locate's hard gate): return null ONLY when the normalized quote is empty
// (an intentional no-anchor). A non-empty quote that scores zero against every target — sharing no
// token with any block — THROWS SnapError rather than snapping to noise. Any score > 0 resolves.
export function snapQuote(
  quote: string,
  targets: SnapTarget[],
): { span: Span; score: number; how: "contains" | "overlap" } | null {
  const nq = normalizeForSnap(quote);
  if (!nq) return null; // empty quote — the no-anchor hole, not a miss.

  // CONTAINS: a block whose text encloses the whole normalized quote. Tie-break to the shortest
  // block so a quote enclosed by both a paragraph and its containing list item snaps to the item.
  const contains = targets.filter((t) => t.nText.includes(nq));
  if (contains.length > 0) {
    contains.sort((a, b) => a.nText.length - b.nText.length);
    return { span: contains[0].span, score: 1, how: "contains" };
  }

  // OVERLAP: maximal distinct-token overlap. `shared` counts each quote-token at most once, so a
  // block that merely repeats a common word cannot outscore the block the quote came from.
  const qt = new Set(tokenize(nq));
  let best: SnapTarget | null = null;
  let bestScore = 0;
  for (const t of targets) {
    const seen = new Set<string>();
    let shared = 0;
    for (const w of t.tokens) {
      if (qt.has(w) && !seen.has(w)) {
        shared++;
        seen.add(w);
      }
    }
    const score = shared / Math.max(1, qt.size);
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }

  if (!best || bestScore === 0) {
    throw new SnapError(
      quote,
      "snap: quote shares no token with any block — cannot anchor. The quote must be a " +
        "(possibly paraphrased) pointer into the source, not unrelated text.",
    );
  }
  return { span: best.span, score: bestScore, how: "overlap" };
}

// Snap a quote that MUST anchor and return its enclosing-block span. Where snapQuote returns null on
// an empty quote (the no-anchor hole), snapRequired HARD-ABORTS on that null with a SnapError — a
// head unit (concept / judgment / inference / procedure-lead / edge) must have a source anchor,
// mirroring how the old byte-exact locate() threw on an empty quote. A non-empty score-0 quote
// already throws SnapError inside snapQuote. This keeps every SnapError construction owned by snap.ts.
export function snapRequired(quote: string, targets: SnapTarget[]): Span {
  const r = snapQuote(quote, targets);
  if (!r) throw new SnapError(quote, "snap: a head unit must anchor, but its quote is empty");
  return r.span;
}
