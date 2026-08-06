// simplify/verify tests — the deterministic apply-gate as pure functions: the two axes (reference
// spans, structural counts) on synthetic original/rewrite pairs, verifyClean, the formatVerify
// rendering, and the argv→result parse. The load-bearing case is the nested-fence truncation the
// span-and-structure diff exists to catch. Pure, offline.
import { expect, test } from "bun:test";
import {
  type VerifyReport,
  formatVerify,
  parseArgs,
  USAGE,
  verify,
  verifyClean,
} from "textkit/simplify/verify.ts";

// A note with all three protected shapes: a reference span each of wikilink, embed, and inline code,
// a heading, and a fenced code block. Individual tests perturb the rewrite to break one axis.
const NOTE = `# Title

We cite [[notes]] and show ![[diagram.png]] with the \`build\` flag.

\`\`\`ts
const x = 1;
\`\`\`

Keep it short.`;

test("verify: a faithful restyle (spans and structure preserved) is clean", () => {
  const rewrite = `# Title

Cite [[notes]]. Show ![[diagram.png]]. Use the \`build\` flag.

\`\`\`ts
const x = 1;
\`\`\`

Short.`;
  const r = verify(NOTE, rewrite);
  expect(r.spans.ok).toBe(true);
  expect(r.spans.original).toBe(3); // wikilink + embed + inline code
  expect(r.headings.ok).toBe(true);
  expect(r.fences.ok).toBe(true);
  expect(verifyClean(r)).toBe(true);
});

test("verify: a dropped reference span is named as drift", () => {
  const rewrite = `# Title

Cite [[notes]]. Use the \`build\` flag.

\`\`\`ts
const x = 1;
\`\`\`

Short.`; // the ![[diagram.png]] embed is gone
  const r = verify(NOTE, rewrite);
  expect(r.spans.ok).toBe(false);
  expect(r.spans.dropped).toEqual(["![[diagram.png]]"]);
  expect(r.spans.invented).toEqual([]);
  expect(verifyClean(r)).toBe(false);
});

test("verify: a mutated span reads as one dropped and one invented", () => {
  const rewrite = NOTE.replace("[[notes]]", "[[note]]"); // typo'd wikilink target
  const r = verify(NOTE, rewrite);
  expect(r.spans.dropped).toEqual(["[[notes]]"]);
  expect(r.spans.invented).toEqual(["[[note]]"]);
});

test("verify: an invented span (not in the source) is drift", () => {
  const rewrite = NOTE.replace("Keep it short.", "Keep it short, per [[style]].");
  const r = verify(NOTE, rewrite);
  expect(r.spans.dropped).toEqual([]);
  expect(r.spans.invented).toEqual(["[[style]]"]);
  expect(verifyClean(r)).toBe(false);
});

test("verify: the nested-fence truncation — a naive extractor stops at the inner fence", () => {
  // The likely real failure: the rewrite kept every reference span up to the code block, then a
  // naive `## rewrite` extractor closed early on the inner ``` and dropped the block and the tail.
  const truncated = `# Title

Cite [[notes]]. Show ![[diagram.png]]. Use the \`build\` flag.`;
  const r = verify(NOTE, truncated);
  // spans alone MISS it — every surviving span is a faithful subset, none dropped or invented...
  expect(r.spans.dropped).toEqual([]);
  // ...but the structural count is the backstop: the fenced block's two markers vanished.
  expect(r.fences.ok).toBe(false);
  expect(r.fences.original).toBe(2);
  expect(r.fences.rewrite).toBe(0);
  expect(verifyClean(r)).toBe(false);
});

test("verify: a dropped heading is drift even when every span survives", () => {
  const rewrite = NOTE.replace("# Title\n\n", ""); // heading gone, all spans and the fence intact
  const r = verify(NOTE, rewrite);
  expect(r.spans.ok).toBe(true);
  expect(r.headings.ok).toBe(false);
  expect(r.headings.original).toBe(1);
  expect(r.headings.rewrite).toBe(0);
});

test("verify: a '#' comment inside a fenced block is not counted as a heading", () => {
  const src = "Intro.\n\n```bash\n# not a heading\necho hi\n```";
  const rewrite = "Rewritten intro.\n\n```bash\n# not a heading\necho hi\n```";
  const r = verify(src, rewrite);
  expect(r.headings.original).toBe(0); // the '#' is code, stripFences blanks it
  expect(verifyClean(r)).toBe(true);
});

test("verify: a pure-prose note with no spans leans on the structural backstop", () => {
  const src = "# Heading\n\nA plain sentence with no references at all.";
  const truncated = "A plain sentence with no references at all."; // heading dropped
  const r = verify(src, truncated);
  expect(r.spans.original).toBe(0); // nothing for the span axis to check
  expect(r.spans.ok).toBe(true);
  expect(r.headings.ok).toBe(false); // the backstop catches the drop
  expect(verifyClean(r)).toBe(false);
});

test("formatVerify: a clean report names each axis OK", () => {
  const clean: VerifyReport = {
    spans: { ok: true, original: 3, rewrite: 3, dropped: [], invented: [] },
    headings: { ok: true, original: 1, rewrite: 1 },
    fences: { ok: true, original: 2, rewrite: 2 },
  };
  const out = formatVerify(clean);
  expect(out).toContain("- spans: OK — 3 reference span(s) preserved");
  expect(out).toContain("- headings: OK");
  expect(out).toContain("- fences: OK");
});

test("formatVerify: a drift report names the offending spans and count deltas", () => {
  const r = verify(NOTE, NOTE.replace("[[notes]]", "").replace("\n\n```ts\nconst x = 1;\n```", ""));
  const out = formatVerify(r);
  expect(out).toContain("- spans: DRIFT");
  expect(out).toContain("dropped ([[notes]])");
  expect(out).toContain("- fences: DRIFT — 2 marker(s) in source, 0 in rewrite");
});

// ---- parseArgs (pure) ----

test("parseArgs: -h and --help resolve to help before any I/O", () => {
  expect(parseArgs(["-h"])).toEqual({ kind: "help" });
  expect(parseArgs(["--help"])).toEqual({ kind: "help" });
});

test("parseArgs: an original path with the rewrite defaulting to stdin", () => {
  expect(parseArgs(["note.md"])).toEqual({
    kind: "ok",
    opts: { original: "note.md", rewrite: undefined },
  });
});

test("parseArgs: two positionals bind original then rewrite", () => {
  expect(parseArgs(["note.md", "rewrite.md"])).toEqual({
    kind: "ok",
    opts: { original: "note.md", rewrite: "rewrite.md" },
  });
});

test("parseArgs: misuse is named, not misattributed", () => {
  expect(parseArgs([])).toMatchObject({ kind: "error" }); // no original
  expect(parseArgs(["-"])).toMatchObject({ kind: "error" }); // original cannot be stdin
  expect(parseArgs(["--bogus"])).toEqual({ kind: "error", message: "unknown flag '--bogus'" });
  expect(parseArgs(["a.md", "b.md", "c.md"])).toMatchObject({ kind: "error" }); // extra arg
});

test("parseArgs: `--` ends options so a dash-named file survives; a bare `-` is the rewrite stdin", () => {
  expect(parseArgs(["--", "note.md", "-weird.md"])).toEqual({
    kind: "ok",
    opts: { original: "note.md", rewrite: "-weird.md" },
  });
  expect(parseArgs(["note.md", "-"])).toEqual({
    kind: "ok",
    opts: { original: "note.md", rewrite: "-" },
  });
});

test("USAGE names the exit codes and the no-apply contract", () => {
  expect(USAGE).toContain("applies nothing");
  expect(USAGE).toContain("1 drift (block the apply)");
});
