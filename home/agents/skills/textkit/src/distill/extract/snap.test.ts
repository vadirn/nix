// snap.test.ts — tests for the block-granular anchor primitive. Unlike locate.test.ts, snap()
// resolves an APPROXIMATE model quote to the enclosing mdstruct block, so these tests parse an
// INLINE fixture note and assert that known hard-failure quotes — the ones byte-exact locate broke
// on — snap to their correct source block. The fixture holds five paragraphs copied character-exact
// from the c22c91afaff5 archive (the note the validation spike used) plus one blockquote, so the
// test is self-contained: it needs no out-of-repo file and runs on CI / any machine. parseDoc
// spawns the `mdstruct` binary, which must be on PATH.
//
// The fixture quotes below are the exact model-emitted strings from the cached pre-graph (concept
// ids noted inline). normalizeForSnap folds all punctuation to spaces, so only the word tokens are
// significant — a glyph-swap (U+2011), a flattened link, or a case change still snaps.
//
// `line` is gone from SnapTarget, so assertions slice the snapped span out of the fixture buffer
// (sliceBytes) and check it contains the expected block's distinctive text.
import { expect, test } from "bun:test";
import {
  SnapError,
  buildSnapTargets,
  normalizeForSnap,
  snapQuote,
} from "#src/distill/extract/snap.ts";
import { parseDoc, sliceBytes } from "#src/distill/mdstruct.ts";

// The five source paragraphs the assertions need, copied verbatim from c22c91afaff5.md (lines 12,
// 14, 18, 22, 24), plus one blockquote so the corrected `"blockQuote"` KEEP literal has regression
// coverage — the blockquote is the ONLY node carrying its span's `>` marker, so a snapped slice that
// starts with `>` proves buildSnapTargets kept the blockQuote node (a wrong literal would fall
// through to the inner paragraph, whose slice has no `>`).
const FIXTURE = `Between running Rubocop style rules, Brakeman security scans, and model-controller-system tests, it takes our remote BuildKite-based continuous integration setup about 5m30s to verify a code change is ready to ship for HEY. My Intel 14900K-based Linux box can do that in less than half the time (and my M3 Max isn't that much slower!). So we're going to drop the remote runners and just bring continuous integration back to developer machines at 37signals.

It's remarkable how big of a leap multi-core developer machines have taken over the last five-to-seven years or so. Running all these checks and validations in a reasonable time on a local machine would have been unthinkable not too long ago. But the 14900K has over 20 cores, the M3 Max has 16, and even a lowly M2 MacBook has 8. They're all capable of doing a tremendous amount of parallelized work that would have seem fantastical to do locally in the mid 2010s.

To me, the most satisfying part of the improved performance of modern developer CPUs is the possibility to simplify our stacks. Installing, operating, and caring for a remote CI setup is a substantial complication. Either you do it on your own hardware, and deal with that complexity directly, or you pay through the nose for a cloud-based setup. Getting to flush all of it down the simplification drain is an amazing step forward.

As always, the simplified future is not evenly distributed. I can't see the likes of Shopify or GitHub being able to run the full battery of tests against their millions of lines of code locally any time soon. But 99.99% of all web apps are much closer to HEY in breadth than they are to those behemoths. And small teams ought to remove all the moving parts possible. Never aspire to a more complicated stack than what your application calls for.

So we need to keep burning those [bridges of complexity](https://world.hey.com/dhh/introducing-propshaft-ee60f4f6) once we get to the other side. I can't wait to set fire to every single one of the remote continuous integration bridges we have here at 37signals. Progress is a bonfire.

> a solitary quoted aphorism
`;

const parsed = parseDoc(FIXTURE);
const { buf } = parsed;
const targets = buildSnapTargets(parsed);

// Slice the snapped block's source text out of the fixture buffer (or "" when snapQuote returns null).
function snapText(quote: string): string {
  const s = snapQuote(quote, targets);
  return s ? sliceBytes(buf, s.span) : "";
}

test("normalizeForSnap folds links, wikilinks, glyphs, case, and punctuation to word tokens", () => {
  // A U+2011 non-breaking hyphen and a curly apostrophe fold to spaces; a markdown link flattens
  // to its text; case lowers. The residue is the bare word sequence.
  expect(normalizeForSnap("cloud‑based")).toBe("cloud based");
  expect(normalizeForSnap("It’s [bridges of complexity](https://x/y) — done.")).toBe(
    "it s bridges of complexity done",
  );
  expect(normalizeForSnap("[[Wikilink Alias]]")).toBe("wikilink alias");
});

test("three known hard-failure quotes snap to their correct source block via contains", () => {
  // U+2011 non-breaking hyphen in `cloud‑based` — byte-exact locate's original break. The source
  // block has a plain hyphen; both fold to "cloud based", so it snaps to the line-18 block.
  const cloud = snapQuote(
    "Either you do it on your own hardware, and deal with that complexity directly, or you pay through the nose for a cloud‑based setup.",
    targets,
  );
  expect(cloud?.how).toBe("contains");
  expect(
    snapText(
      "Either you do it on your own hardware, and deal with that complexity directly, or you pay through the nose for a cloud‑based setup.",
    ),
  ).toContain("cloud-based setup");

  // A flattened markdown link (`[bridges of complexity](url)`) inside the source block → the
  // line-24 block, whose distinctive tail is "Progress is a bonfire."
  const bridges = snapQuote(
    "So we need to keep burning those bridges of complexity once we get to the other side.",
    targets,
  );
  expect(bridges?.how).toBe("contains");
  expect(
    snapText(
      "So we need to keep burning those bridges of complexity once we get to the other side.",
    ),
  ).toContain("Progress is a bonfire.");

  // A capitalized `Running` opening a mid-sentence slice — case fold → the line-12 block, whose
  // distinctive phrase is "Brakeman security scans".
  const running = snapQuote(
    "Running Rubocop style rules, Brakeman security scans, and model-controller-system tests",
    targets,
  );
  expect(running?.how).toBe("contains");
  expect(
    snapText(
      "Running Rubocop style rules, Brakeman security scans, and model-controller-system tests",
    ),
  ).toContain("Brakeman security scans");
});

test("same-block stitch: a quote joining two non-adjacent sentences snaps to their shared block", () => {
  // The "developer machines" concept quote (pre-graph id "developer machines") stitches the first
  // and last sentences of the line-14 paragraph, ELIDING the middle one — so no block contains it
  // whole; the token-overlap fallback still lands it on the line-14 block, whose distinctive word
  // "fantastical" appears nowhere else in the fixture.
  const q =
    "It's remarkable how big of a leap multi‑core developer machines have taken over the last five‑to‑seven years or so. But the 14900K has over 20 cores, the M3 Max has 16, and even a lowly M2 MacBook has 8. They're all capable of doing a tremendous amount of parallelized work that would have seem fantastical to do locally in the mid 2010s.";
  const s = snapQuote(q, targets);
  expect(s).not.toBeNull();
  expect(s?.how).toBe("overlap"); // middle sentence elided → not a pure contains
  expect(snapText(q)).toContain("fantastical to do locally");
});

test("cross-block quote resolves to a valid source block without throwing", () => {
  // The "simplified stack" concept quote (pre-graph id "simplified stack") spans TWO blocks: the
  // opening phrase lives in the line-18 block, the closing sentence in the line-22 block. No block
  // encloses it whole; overlap resolves it to ONE valid block (its larger token share) rather than
  // throwing.
  const q =
    "the possibility to simplify our stacks. Never aspire to a more complicated stack than what your application calls for.";
  const s = snapQuote(q, targets);
  expect(s).not.toBeNull();
  // Whichever block it lands on is a real fixture block — the slice is a substring of the source.
  expect(FIXTURE).toContain(snapText(q));
});

test("a quote inside a blockquote snaps to the blockQuote block (KEEP literal regression)", () => {
  // Exercises the corrected `"blockQuote"` KEEP literal from fix 5: the blockquote is kept as its
  // own snap target, so the snapped slice carries the `>` marker only that node's span holds.
  const s = snapQuote("a solitary quoted aphorism", targets);
  expect(s?.how).toBe("contains");
  expect(snapText("a solitary quoted aphorism")).toContain("> a solitary quoted aphorism");
});

test("garbage quote sharing no token throws SnapError (the hard gate holds)", () => {
  expect(() => snapQuote("zzzxxx qqq nonsense words", targets)).toThrow(SnapError);
  try {
    snapQuote("zzzxxx qqq nonsense words", targets);
  } catch (e) {
    expect(e).toBeInstanceOf(SnapError);
    expect((e as SnapError).quote).toBe("zzzxxx qqq nonsense words");
  }
});

test("empty / whitespace quote returns null — the intentional no-anchor hole", () => {
  expect(snapQuote("   ", targets)).toBeNull();
  expect(snapQuote("", targets)).toBeNull();
});
