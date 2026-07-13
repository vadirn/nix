// graph.test.ts — unit tests for the canonical graph helpers: formatSpan/parseSpan round-trip
// (bare and bracketed) and computeSource parity with mdstruct's build.rs. Run with `bun test`
// from this directory. No mdstruct binary needed — graph.ts is a pure leaf.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { computeSource, formatSpan, parseSpan } from "./graph.ts";
import type { Span } from "./mdstruct.ts";

test("formatSpan emits the bare start..end notation", () => {
  expect(formatSpan([289, 442])).toBe("289..442");
  expect(formatSpan([0, 0])).toBe("0..0");
});

test("parseSpan reads the bare form", () => {
  expect(parseSpan("289..442")).toEqual([289, 442]);
});

test("parseSpan reads the bracketed form to the same range", () => {
  expect(parseSpan("[289..442]")).toEqual([289, 442]);
});

test("parseSpan tolerates surrounding whitespace", () => {
  expect(parseSpan("  289..442  ")).toEqual([289, 442]);
  expect(parseSpan("  [289..442]  ")).toEqual([289, 442]);
});

test("formatSpan/parseSpan round-trip, bare and bracketed", () => {
  const span: Span = [12, 87];
  expect(parseSpan(formatSpan(span))).toEqual(span);
  expect(parseSpan(`[${formatSpan(span)}]`)).toEqual(span);
});

test("parseSpan rejects malformed anchors (hard failure, no sentinel)", () => {
  expect(() => parseSpan("289-442")).toThrow(); // wrong separator
  expect(() => parseSpan("289..")).toThrow(); // missing end
  expect(() => parseSpan("[289..442")).toThrow(); // unbalanced bracket
  expect(() => parseSpan("289..442]")).toThrow(); // unbalanced bracket
  expect(() => parseSpan("abc..def")).toThrow(); // non-numeric
});

test("computeSource: bytes = UTF-8 length, sha256 = 12-hex prefix of sha256 over the UTF-8 bytes", () => {
  // "abc" is the canonical NIST sha256 test vector; computeSource truncates to 12 hex to match
  // the frontmatter convention (apply-mode.ts:96 / pipeline.ts:1917 `.slice(0, 12)`).
  const src = computeSource("note.md", "abc");
  expect(src.path).toBe("note.md");
  expect(src.bytes).toBe(3);
  expect(src.sha256).toBe("ba7816bf8f01");
});

test("computeSource counts UTF-8 bytes, not JS string length, for non-ASCII", () => {
  // "café" is 5 UTF-8 bytes (é = 2) but 4 JS chars; "Привет" is 12 bytes (6 × 2) but 6 chars.
  const cafe = computeSource("x.md", "café");
  expect(cafe.bytes).toBe(5);
  expect(cafe.bytes).not.toBe("café".length);

  const cyr = computeSource("y.md", "Привет");
  expect(cyr.bytes).toBe(12);
});

test("computeSource sha256 agrees with the 12-hex prefix of an independent createHash over the same UTF-8 bytes", () => {
  const text = "Записка — короткая. Keep it short.\n";
  const src = computeSource("z.md", text);
  const expected = createHash("sha256")
    .update(Buffer.from(text, "utf8"))
    .digest("hex")
    .slice(0, 12);
  expect(src.sha256).toBe(expected);
  expect(src.bytes).toBe(Buffer.byteLength(text, "utf8"));
});
