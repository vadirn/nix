// frontmatter structural-parser tests — run with `bun test` from this directory.
//
// Pins the one structural frontmatter scan (parseFrontmatter) against fixtures that
// exercise three fence/YAML hazards flagged as a silent-loss bug: a BOM-prefixed
// fence, a trailing-space `---` fence, and malformed inner YAML. The contract is:
// well-formed input is unchanged, and a hazard never demotes the frontmatter block
// to body (where the pipeline would reword it as prose) — a malformed block is
// flagged via `error` while still returned verbatim in `front`.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "bun:test";
import { parseDescription, parseFrontmatter, parseType } from "textkit/core/frontmatter.ts";

const FIX = (name: string): string =>
  readFileSync(resolve(import.meta.dir, "..", "fixtures", name), "utf8");

// ---- baseline: well-formed input is split byte-for-byte and parses clean ----
test("parseFrontmatter: well-formed block splits front/body and reports no error", () => {
  const fm = parseFrontmatter(FIX("frontmatter-wellformed.md"));
  expect(fm.front).toBe("---\ntype: note\ndescription: A well-formed anchor\n---\n");
  expect(fm.body).toBe("Body after a well-formed block.\n");
  expect(fm.error).toBeNull();
  expect(parseType(fm.front)).toBe("note");
  expect(parseDescription(fm.front)).toBe("A well-formed anchor");
});

test("parseFrontmatter: no opening fence yields empty front and whole text as body", () => {
  const text = "Just a body paragraph.\n\nNo frontmatter here.\n";
  const fm = parseFrontmatter(text);
  expect(fm.front).toBe("");
  expect(fm.body).toBe(text);
  expect(fm.error).toBeNull();
});

test("parseFrontmatter: opening fence with no closing fence is not a block (whole text is body)", () => {
  const text = "---\ntype: note\nstill going, never closes\n";
  const fm = parseFrontmatter(text);
  expect(fm.front).toBe("");
  expect(fm.body).toBe(text);
  expect(fm.error).toBeNull();
});

// ---- hazard 1: a BOM ahead of the fence must not hide the block ----
test("parseFrontmatter: BOM-prefixed fence is recognized, BOM stripped, metadata preserved", () => {
  const fm = parseFrontmatter(FIX("frontmatter-bom.md"));
  // The block is kept (not demoted to body) and the BOM is gone from front.
  expect(fm.front).toBe("---\ntype: note\ndescription: A BOM-prefixed anchor\n---\n");
  expect(fm.front.startsWith("\uFEFF")).toBe(false);
  expect(fm.body).toBe("Body after a BOM-prefixed fence.\n");
  expect(fm.error).toBeNull();
  expect(parseType(fm.front)).toBe("note");
  expect(parseDescription(fm.front)).toBe("A BOM-prefixed anchor");
});

// ---- hazard 2: trailing whitespace on the fences must still close the block ----
test("parseFrontmatter: trailing-space fences still bound the block, metadata preserved", () => {
  const fm = parseFrontmatter(FIX("frontmatter-trailing-space.md"));
  expect(fm.front).not.toBe(""); // was a silent loss under the old prefix test
  expect(fm.body).toBe("Body after trailing-space fences.\n");
  expect(fm.body).not.toContain("type: card"); // metadata did not leak into body
  expect(fm.error).toBeNull();
  expect(parseType(fm.front)).toBe("card");
  expect(parseDescription(fm.front)).toBe("Trailing space on fences");
});

// ---- hazard 3: malformed inner YAML is flagged, never reworded as prose ----
test("parseFrontmatter: malformed YAML is flagged but the block stays verbatim in front", () => {
  const fm = parseFrontmatter(FIX("frontmatter-malformed.md"));
  expect(fm.error).not.toBeNull();
  expect(fm.front).toContain("tags: [unclosed"); // block kept verbatim
  expect(fm.body).toBe("Body after a malformed frontmatter block.\n");
  // the silent-loss bug: the frontmatter must NOT have been demoted into the body.
  expect(fm.body).not.toContain("tags: [unclosed");
  expect(fm.front).not.toBe("");
});
