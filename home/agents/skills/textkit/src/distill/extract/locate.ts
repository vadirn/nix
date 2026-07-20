// locate.ts — the span-locate fidelity primitive. The model NEVER emits byte offsets; it quotes
// the source slice a unit was distilled from, and this module locates that quote and computes
// the half-open UTF-8 byte span. That turns the anchor from an LLM promise into a DETERMINISTIC
// fidelity check: a failed locate is a HARD GATE — it throws a typed LocateError, never returns a
// sentinel, so a hallucinated or mis-copied quote cannot pass silently as a bogus span. Matching is
// byte-exact only — no whitespace or glyph-equivalence retry; block-granular tolerance for
// model-approximate quotes now lives in `snap.ts`.
//
// It is a leaf over mdstruct.ts: reuses `Span` and `sliceBytes` (the byte-exact slice the
// computed span must round-trip against). It does NOT validate edge `rel` — REL_REGISTRY in
// text.ts stays the sole source of truth for that.
import { sliceBytes, type Span } from "textkit/distill/mdstruct.ts";

// The two ways a locate can fail the gate. `not-found` = the quote does not occur in the source
// (0 matches). `ambiguous` = it occurs at more than one position, so the span is not uniquely
// determined; the caller should re-emit a longer quote with disambiguating context.
export type LocateFailure = "not-found" | "ambiguous";

// LocateError is the typed hard-gate failure locate() throws on a not-found or ambiguous quote;
// `kind` names which of the two, `quote` carries the offending text for the error message.
export class LocateError extends Error {
  readonly kind: LocateFailure;
  readonly quote: string;
  constructor(kind: LocateFailure, quote: string, message: string) {
    super(message);
    this.name = "LocateError";
    this.kind = kind;
    this.quote = quote;
  }
}

// Every JS-string start index at which `quote` occurs exactly. Advances by one code unit so
// overlapping occurrences are counted too — >1 means the span is not uniquely determined.
function exactHits(source: string, quote: string): number[] {
  const hits: number[] = [];
  let from = 0;
  for (;;) {
    const idx = source.indexOf(quote, from);
    if (idx === -1) break;
    hits.push(idx);
    from = idx + 1;
  }
  return hits;
}

// Convert a JS-string match (start index + matched text) into a half-open UTF-8 byte span. JS
// string indices are UTF-16 code units and diverge from bytes on any non-ASCII (Cyrillic,
// em-dashes), so the only correct conversion is the UTF-8 byte length of the prefix. The
// round-trip against `sliceBytes` is asserted as a hard invariant.
function toSpan(source: string, index: number, matched: string): Span {
  const start = Buffer.byteLength(source.slice(0, index), "utf8");
  const end = start + Buffer.byteLength(matched, "utf8");
  const span: Span = [start, end];
  const round = sliceBytes(Buffer.from(source, "utf8"), span);
  if (round !== matched) {
    throw new Error(
      `locate: byte-span round-trip failed — span ${start}..${end} slices ` +
        `${JSON.stringify(round)}, expected ${JSON.stringify(matched)}. This is a bug in the ` +
        "byte-offset conversion, not a bad quote.",
    );
  }
  return span;
}

// Locate `quote` in `source` and return its half-open UTF-8 byte span. Byte-exact match only —
// no whitespace or glyph-equivalence retry. A failed locate throws a LocateError (the hard gate).
// Never returns a sentinel.
export function locate(source: string, quote: string): Span {
  if (quote.trim().length === 0) {
    throw new LocateError("not-found", quote, "locate: empty quote — nothing to anchor.");
  }

  const exact = exactHits(source, quote);
  if (exact.length === 1) return toSpan(source, exact[0], quote);
  if (exact.length > 1) {
    throw new LocateError(
      "ambiguous",
      quote,
      `locate: quote occurs ${exact.length} times — span is not unique. ` +
        "Re-emit a longer quote with disambiguating context.",
    );
  }

  throw new LocateError(
    "not-found",
    quote,
    "locate: quote not found in source. The quote must be a verbatim slice of the source.",
  );
}
