// normalize-citation tests — pins each gentle-fold transform independently, then the two
// properties the citation substring-check leans on: leading-whitespace tolerance (a mid-indent
// source block still contains its evidence) and prose-punctuation survival (a numeric or
// negation distortion still FAILS to substring-match, because the fold keeps the punctuation
// snap's aggressive fold would erase). Run with `bun test normalize-citation.test.ts`.
import { expect, test } from "bun:test";
import { normalizeCitation } from "#src/distill/review/normalize-citation.ts";

// the substring relation the Step-3 gate will apply: normalize both sides, ask CONTAINS.
const contains = (evidence: string, source: string): boolean =>
  normalizeCitation(source).includes(normalizeCitation(evidence));

test("whitespace-collapse: runs of spaces/tabs/newlines fold to one space", () => {
  expect(normalizeCitation("a   b\t\tc\n\nd")).toBe("a b c d");
});

test("smart-quote fold: curly single and double quotes become straight", () => {
  expect(normalizeCitation("‘a’ and “b”")).toBe("'a' and \"b\"");
  expect(normalizeCitation("‚q‛ „w‟")).toBe("'q' \"w\"");
});

test("list-marker strip: ordered and bullet markers drop, text survives", () => {
  expect(normalizeCitation("1. first")).toBe("first");
  expect(normalizeCitation("2) second")).toBe("second");
  expect(normalizeCitation("- third")).toBe("third");
  expect(normalizeCitation("* fourth")).toBe("fourth");
  expect(normalizeCitation("+ fifth")).toBe("fifth");
});

test("fence strip: fenced-code fence lines (with info string) drop", () => {
  expect(normalizeCitation("```ts\nconst x = 1\n```")).toBe("const x = 1");
});

test("blockquote and heading strip: leading > and # markers drop", () => {
  expect(normalizeCitation("> quoted line")).toBe("quoted line");
  expect(normalizeCitation(">> nested quote")).toBe("nested quote");
  expect(normalizeCitation("### Heading text")).toBe("heading text");
});

test("inline-emphasis strip: *, _, `, ~ markup glyphs drop", () => {
  expect(normalizeCitation("**bold** and _em_ and `code` and ~~s~~")).toBe(
    "bold and em and code and s",
  );
});

test("link and wikilink unwrap: inner text survives, target drops", () => {
  expect(normalizeCitation("see [the docs](https://x.example/y)")).toBe("see the docs");
  expect(normalizeCitation("![alt text](img.png)")).toBe("alt text");
  expect(normalizeCitation("refer to [[Widget Note]]")).toBe("refer to widget note");
  expect(normalizeCitation("![[embed target]]")).toBe("embed target");
});

test("case-fold: uppercase folds to lowercase", () => {
  expect(normalizeCitation("MixedCase TEXT")).toBe("mixedcase text");
});

test("leading-whitespace tolerance: a mid-indent block still CONTAINS its evidence", () => {
  // mirrors the Docker gold-set pf4/pi2 shape: the source block starts mid-indent, the judge's
  // cited evidence has no such indent — the per-line leading-indent strip must let it match.
  const source = "      the retry budget caps at three attempts before the circuit opens.";
  const evidence = "the retry budget caps at three attempts";
  expect(contains(evidence, source)).toBe(true);
});

test("prose punctuation survives: a numeric distortion still fails to substring-match", () => {
  // the whole point of the gentle fold vs normalizeForSnap: the digit and its unit are kept, so a
  // 10ms->50ms swap does NOT punctuation-blindly match the source.
  const source = "the debounce fires after 10ms of silence.";
  expect(contains("fires after 10ms", source)).toBe(true); // faithful span matches
  expect(contains("fires after 50ms", source)).toBe(false); // distorted span does not
});

test("prose punctuation survives: an inserted negation still fails to substring-match", () => {
  const source = "the cache is invalidated on write.";
  expect(contains("cache is invalidated on write", source)).toBe(true);
  expect(contains("cache is not invalidated on write", source)).toBe(false);
});
