// graph.test.ts — unit tests for the canonical graph helpers: formatSpan/parseSpan round-trip
// (bare and bracketed) and computeSource parity with mdstruct's build.rs. Run with `bun test`
// from this directory. No mdstruct binary needed — graph.ts is a pure leaf.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { computeSource, formatSpan, parseSpan, stampSha } from "textkit/distill/graph/graph.ts";
import { stampHash } from "textkit/distill/review/execute.ts";
import type { Span } from "textkit/distill/mdstruct.ts";

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
  // "abc" is the canonical NIST sha256 test vector; computeSource truncates to 12 hex via the
  // shared stampSha primitive (apply-mode's stampHash prefixes the same value with `sha256:`).
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

test("the three stamp paths agree: stampSha, computeSource.sha256, and apply-mode's stampHash", () => {
  // R3: the 12-hex width lives in ONE place (stampSha). computeSource stamps the bare form into
  // frontmatter; apply-mode/emit's stampHash prefixes the SAME value with `sha256:`. A width drift
  // at one site (not the other) would make apply's src= verification silently mis-verify.
  const text = "Записка — короткая. Keep it short.\n";
  const bytes = Buffer.from(text, "utf8");
  const bare = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  // 1. the primitive equals an independent 12-hex digest, over both a string and its UTF-8 Buffer
  expect(stampSha(text)).toBe(bare);
  expect(stampSha(bytes)).toBe(bare); // pipeline passes a Buffer, apply-mode a string — same bytes
  // 2. computeSource's bare frontmatter field is that same stamp
  expect(computeSource("z.md", text).sha256).toBe(bare);
  // 3. apply-mode/emit's prefixed stamp is the same value under a `sha256:` label
  expect(stampHash(text)).toBe(`sha256:${bare}`);
  expect(stampHash(bytes)).toBe(`sha256:${bare}`);
});
