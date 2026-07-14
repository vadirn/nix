// locate.test.ts — tests for the span-locate fidelity primitive. Covers three invariants:
// byte-offset conversion + round-trip, the 0/1/>1 match gate, and the whitespace-collapsed
// single retry computing the span from the raw extent. Run with `bun test` from this
// directory. No mdstruct binary needed — locate.ts only reuses the pure `sliceBytes`/`Span`
// from mdstruct.ts, not the CLI wrapper.
import { expect, test } from "bun:test";
import { LocateError, locate } from "@/extract/locate.ts";
import { sliceBytes } from "@/kernel/mdstruct.ts";

// Round-trip a computed span against the byte-exact slice — the hard invariant every locate must
// satisfy.
function slice(source: string, span: [number, number]): string {
  return sliceBytes(Buffer.from(source, "utf8"), span);
}

test("ASCII exact match: locates and round-trips; span equals JS indices when all-ASCII", () => {
  const source = "The quick brown fox jumps over the lazy dog.";
  const quote = "quick brown fox";
  const span = locate(source, quote);

  // For pure ASCII, byte offsets coincide with JS string indices.
  const idx = source.indexOf(quote);
  expect(span).toEqual([idx, idx + quote.length]);
  expect(slice(source, span)).toBe(quote);
});

test("non-ASCII (Cyrillic + em-dash): byte offsets differ from JS string indices and round-trip", () => {
  // "Записка — короткая." has Cyrillic (2 bytes each) and an em-dash (3 bytes), so every byte
  // offset past the start diverges from the UTF-16 code-unit index.
  const source = "Записка — короткая. Keep it short.";
  const quote = "короткая";

  const span = locate(source, quote);
  const jsIndex = source.indexOf(quote);

  // The byte start must be strictly greater than the JS index (2-byte Cyrillic + 3-byte em-dash
  // precede it), proving the conversion is real and not identity.
  expect(span[0]).toBeGreaterThan(jsIndex);
  // And it still slices back to the exact quote.
  expect(slice(source, span)).toBe(quote);

  // A quote that spans the em-dash itself also round-trips.
  const wide = "Записка — короткая";
  const wideSpan = locate(source, wide);
  expect(slice(source, wideSpan)).toBe(wide);
  expect(wideSpan[0]).toBe(0);
});

test("not-found: throws a typed LocateError, never a sentinel", () => {
  const source = "The quick brown fox.";
  expect(() => locate(source, "purple elephant")).toThrow(LocateError);
  try {
    locate(source, "purple elephant");
  } catch (e) {
    expect(e).toBeInstanceOf(LocateError);
    expect((e as LocateError).kind).toBe("not-found");
  }
});

test("ambiguous: a quote appearing twice throws asking for a longer quote", () => {
  const source = "set the flag. later, set the flag again.";
  expect(() => locate(source, "set the flag")).toThrow(LocateError);
  try {
    locate(source, "set the flag");
  } catch (e) {
    expect((e as LocateError).kind).toBe("ambiguous");
    expect((e as LocateError).message).toContain("longer quote");
  }
});

test("whitespace-collapsed fallback: a line-wrapped quote locates and the RAW extent round-trips", () => {
  // The source wraps the sentence across a newline and doubles a space; the model's quote uses
  // single spaces. Exact match fails; the single collapsed retry locates it.
  const source = "Keep the note\nshort  and dense, then stop.";
  const quote = "Keep the note short and dense";

  const span = locate(source, quote);
  // The returned span covers the RAW extent in source (with the newline and double space), so
  // sliceBytes round-trips to the raw text — NOT to the collapsed quote.
  const raw = "Keep the note\nshort  and dense";
  expect(slice(source, span)).toBe(raw);
  expect(slice(source, span)).not.toBe(quote);
});

test("whitespace-collapsed fallback across non-ASCII line wrap round-trips byte-exact", () => {
  const source = "приоритет\nдат, не булевых флагов — так надёжнее.";
  const quote = "приоритет дат, не булевых флагов";
  const span = locate(source, quote);
  expect(slice(source, span)).toBe("приоритет\nдат, не булевых флагов");
});

test("whitespace-collapsed fallback is still gated: two collapsed occurrences are ambiguous", () => {
  const source = "do it\nnow. and again, do it  now.";
  expect(() => locate(source, "do it now")).toThrow(LocateError);
  try {
    locate(source, "do it now");
  } catch (e) {
    expect((e as LocateError).kind).toBe("ambiguous");
  }
});

test("empty quote is a not-found gate, not a zero-length span", () => {
  expect(() => locate("anything", "   ")).toThrow(LocateError);
  try {
    locate("anything", "");
  } catch (e) {
    expect((e as LocateError).kind).toBe("not-found");
  }
});

test("regex metacharacters in the quote are matched literally", () => {
  const source = "compute a[0]..b (the range) end.";
  const quote = "a[0]..b (the range)";
  const span = locate(source, quote);
  expect(slice(source, span)).toBe(quote);
});
