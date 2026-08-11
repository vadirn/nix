// simplify/verify tests — the deterministic apply-gate: the two axes (reference spans, structural
// counts) on synthetic original/rewrite pairs, verifyClean, the formatVerify rendering, and the
// argv→result parse. The load-bearing case is the nested-fence truncation the span-and-structure
// diff exists to catch. Offline, but not process-free: the three structural axes read one mdstruct
// parse per side, so these need the binary on PATH — which the exit-5 tests at the bottom pin.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  // naive `## Rewrite` extractor closed early on the inner ``` and dropped the block and the tail.
  const truncated = `# Title

Cite [[notes]]. Show ![[diagram.png]]. Use the \`build\` flag.`;
  const r = verify(NOTE, truncated);
  // spans alone MISS it — every surviving span is a faithful subset, none dropped or invented...
  expect(r.spans.dropped).toEqual([]);
  // ...but the structural count is the backstop: the one code block vanished. The axis counts
  // BLOCKS, so a whole dropped block reads 1 → 0.
  expect(r.fences.ok).toBe(false);
  expect(r.fences.original).toBe(1);
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
  expect(r.headings.original).toBe(0); // the '#' is code block content, so it is no heading
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

// ---- HTML comments (a verbatim span, not a count) ----

// A ticket-template note carrying the exact comment the measured defect rewrote. The comment is the
// instruction the template copies verbatim into every ticket it creates, so a per-copy restyle makes
// the copies diverge.
const WITH_COMMENT = `# Ticket

<!-- Body stays repo-self-sufficient: keep [[wikilinks]] and vault-entry references to the frontmatter. -->

Some body prose to restyle.`;

test("verify: a reworded HTML comment is named as drift, both halves", () => {
  // The measured failure, verbatim: `repo-self-sufficient` (the body resolves for a reader holding
  // only the git repo) became plain `self-sufficient`, dropping the qualifier that carried the
  // condition. Every COUNT in the note is unchanged — one comment before, one after — which is why
  // a comment has to be a content span and not a fifth count axis.
  const rewrite = WITH_COMMENT.replace(
    "Body stays repo-self-sufficient:",
    "The body stays self-sufficient:",
  );
  const r = verify(WITH_COMMENT, rewrite);
  expect(r.spans.ok).toBe(false);
  expect(r.spans.dropped).toEqual([
    "<!-- Body stays repo-self-sufficient: keep [[wikilinks]] and vault-entry references to the frontmatter. -->",
  ]);
  expect(r.spans.invented).toEqual([
    "<!-- The body stays self-sufficient: keep [[wikilinks]] and vault-entry references to the frontmatter. -->",
  ]);
  // the count axes all still pass — before this change the gate returned exit 0 on this rewrite
  expect(r.headings.ok).toBe(true);
  expect(r.fences.ok).toBe(true);
  expect(r.thematic.ok).toBe(true);
  expect(verifyClean(r)).toBe(false);
  expect(formatVerify(r)).toContain("- spans: DRIFT — 1 dropped");
});

test("verify: an untouched HTML comment counts as one span, not two with its nested wikilink", () => {
  const rewrite = WITH_COMMENT.replace("Some body prose to restyle.", "Restyled prose.");
  const r = verify(WITH_COMMENT, rewrite);
  expect(r.spans.ok).toBe(true);
  expect(r.spans.original).toBe(1); // the inner [[wikilinks]] is part of the comment atom
  expect(verifyClean(r)).toBe(true);
});

test("verify: a dropped HTML comment is drift", () => {
  const rewrite = "# Ticket\n\nSome body prose to restyle.";
  const r = verify(WITH_COMMENT, rewrite);
  expect(r.spans.dropped.length).toBe(1);
  expect(r.spans.invented).toEqual([]);
  expect(verifyClean(r)).toBe(false);
});

// ---- thematic breaks (the structure axis for a `---` separator) ----

// A note whose scaffolding includes a `---` thematic break — the gh-stack-footer shape the restyle
// was observed to drop.
const WITH_BREAK = `# Title

Body text here.

---

Footer note.`;

test("verify: a dropped `---` thematic break is drift even when spans and headings survive", () => {
  const rewrite = `# Title

Body text here.

Footer note.`; // the --- separator is gone
  const r = verify(WITH_BREAK, rewrite);
  expect(r.spans.ok).toBe(true);
  expect(r.headings.ok).toBe(true);
  expect(r.thematic.ok).toBe(false);
  expect(r.thematic.original).toBe(1);
  expect(r.thematic.rewrite).toBe(0);
  expect(verifyClean(r)).toBe(false);
});

test("verify: an invented `---` thematic break is drift", () => {
  const rewrite = `# Title

Body text here.

---

---

Footer note.`; // a second break the source never had
  const r = verify(WITH_BREAK, rewrite);
  expect(r.thematic.original).toBe(1);
  expect(r.thematic.rewrite).toBe(2);
  expect(verifyClean(r)).toBe(false);
});

test("verify: a faithful restyle that keeps the `---` break verifies clean", () => {
  const rewrite = `# Title

Text.

---

Footer.`;
  const r = verify(WITH_BREAK, rewrite);
  expect(r.thematic.ok).toBe(true);
  expect(verifyClean(r)).toBe(true);
});

test("verify: frontmatter `---` delimiters are not counted as thematic breaks", () => {
  const src = `---
title: Note
---

# Heading

Body.`;
  const rewrite = `---
title: Note
---

# Heading

Shorter body.`;
  const r = verify(src, rewrite);
  expect(r.thematic.original).toBe(0); // a frontmatter delimiter is not a break
  expect(r.thematic.ok).toBe(true);
  expect(verifyClean(r)).toBe(true);
});

test("verify: a `---` inside a fenced block is not counted as a thematic break", () => {
  const src = "Intro.\n\n```\n---\n```\n\nOutro.";
  const rewrite = "Rewritten intro.\n\n```\n---\n```\n\nOutro.";
  const r = verify(src, rewrite);
  expect(r.thematic.original).toBe(0); // the --- is code block content, so it is no break
  expect(verifyClean(r)).toBe(true);
});

// ---- the parsed structure axes (mdstruct reads all three) ----
// Each case below is one the line-scanning axes got wrong. They are the reason the three counts
// moved onto the parse tree.

// A setext-underlined heading: `Sub` over a `---` rule is an h2 whose second line IS that rule. The
// old scan read it as zero headings and one thematic break — the exact inversion.
const SETEXT = "Sub\n---\n\nBody text here.\n";

test("verify: a setext-underlined heading counts as one heading per side, and as no thematic break", () => {
  const r = verify(SETEXT, "Sub\n---\n\nShorter body.\n");
  expect(r.headings.original).toBe(1);
  expect(r.headings.rewrite).toBe(1);
  expect(r.thematic.original).toBe(0); // the rule belongs to the heading, not to this axis
  expect(verifyClean(r)).toBe(true);
});

test("verify: a setext heading normalized to ATX form no longer trips both count axes at once", () => {
  // Same document, two spellings of one h2. The old axes read it as headings 0 → 1 AND thematic
  // 1 → 0, so the gate blocked a correct restyle on two counts at once.
  const r = verify(SETEXT, "## Sub\n\nShorter body.\n");
  expect(r.headings.original).toBe(1);
  expect(r.headings.rewrite).toBe(1);
  expect(r.thematic.original).toBe(0);
  expect(r.thematic.rewrite).toBe(0);
  expect(verifyClean(r)).toBe(true);
});

test("verify: a setext heading rewritten to a bare rule is drift, where the old axes cancelled", () => {
  // The heading's TEXT is gone and its underline is left standing as a separator. The old counts
  // both stayed put (one ATX heading, one `---` line on each side), so the gate passed it silently.
  const src = "# Title\n\nSub\n---\n\nBody text here.\n";
  const rewrite = "# Title\n\n---\n\nBody text here.\n";
  const r = verify(src, rewrite);
  expect(r.headings.original).toBe(2);
  expect(r.headings.rewrite).toBe(1);
  expect(r.thematic.original).toBe(0);
  expect(r.thematic.rewrite).toBe(1);
  expect(verifyClean(r)).toBe(false);
});

test("verify: a `#` line inside YAML frontmatter is not a heading, so a body-only rewrite is clean", () => {
  // The CLI reads a whole file as the original and takes the rewrite on stdin, so the skill pipes
  // the body alone. The old scan counted the YAML comment as a heading on the original side only,
  // and reported false drift on every such note.
  const src = "---\ntitle: Note\n# a yaml comment\n---\n\n# Real heading\n\nBody text here.\n";
  const rewrite = "# Real heading\n\nShorter body.\n";
  const r = verify(src, rewrite);
  expect(r.headings.original).toBe(1);
  expect(r.headings.rewrite).toBe(1);
  expect(verifyClean(r)).toBe(true);
});

// A fenced block indented inside a blockquote. The old latching scanner never saw the `>` prefix,
// so it read the whole quote as prose and counted zero markers.
const QUOTED_FENCE = "> ```js\n> const a = 1;\n> ```\n\nAfter.\n";

test("verify: a fence inside a blockquote is one code block, so dropping it is drift", () => {
  const kept = verify(QUOTED_FENCE, "> ```js\n> const a = 1;\n> ```\n\nAfter that.\n");
  expect(kept.fences.original).toBe(1);
  expect(kept.fences.rewrite).toBe(1);
  expect(kept.fences.ok).toBe(true);
  const dropped = verify(QUOTED_FENCE, "After.\n");
  expect(dropped.fences.original).toBe(1);
  expect(dropped.fences.rewrite).toBe(0);
  expect(verifyClean(dropped)).toBe(false);
});

test("formatVerify: a clean report names each axis OK", () => {
  const clean: VerifyReport = {
    spans: { ok: true, original: 3, rewrite: 3, dropped: [], invented: [] },
    headings: { ok: true, original: 1, rewrite: 1 },
    fences: { ok: true, original: 2, rewrite: 2 },
    thematic: { ok: true, original: 1, rewrite: 1 },
  };
  const out = formatVerify(clean);
  expect(out).toContain("- spans: OK — 3 reference span(s) preserved");
  expect(out).toContain("- headings: OK");
  expect(out).toContain("- fences: OK");
  expect(out).toContain("- thematic breaks: OK");
});

test("formatVerify: a drift report names the offending spans and count deltas", () => {
  const r = verify(NOTE, NOTE.replace("[[notes]]", "").replace("\n\n```ts\nconst x = 1;\n```", ""));
  const out = formatVerify(r);
  expect(out).toContain("- spans: DRIFT");
  expect(out).toContain("dropped ([[notes]])");
  expect(out).toContain("- fences: DRIFT — 1 code block(s) in source, 0 in rewrite");
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
  expect(USAGE).toContain("5 the gate could not run");
});

// ---- exit 5: the gate could not run (spawned, offline) ----
// The bin/ wrapper, not the entrypoint module: spawning what PATH resolves keeps the deploy seam
// under test too. MDSTRUCT_BIN points at a path that does not exist, which is the missing-binary
// case the wrapper's fail-loud contract raises.

const VERIFY_BIN = join(import.meta.dir, "..", "..", "bin", "simplify-verify");

test("main: a missing mdstruct binary exits 5 — distinct from 1 — and prints no report", () => {
  const dir = mkdtempSync(join(tmpdir(), "simplify-verify-"));
  const originalPath = join(dir, "note.md");
  const rewritePath = join(dir, "rewrite.md");
  // The two sides are IDENTICAL, so a working gate would exit 0. The exit is 5 because the gate
  // never ran — nothing about the rewrite decided it.
  writeFileSync(originalPath, "# Title\n\nBody text here.\n");
  writeFileSync(rewritePath, "# Title\n\nBody text here.\n");
  const proc = Bun.spawnSync([VERIFY_BIN, originalPath, rewritePath], {
    env: { ...process.env, MDSTRUCT_BIN: join(dir, "no-such-mdstruct") },
  });
  expect(proc.exitCode).toBe(5);
  expect(proc.stdout.toString()).toBe(""); // no report: there is no verdict to print
  expect(proc.stderr.toString()).toContain("the gate could not run");
});

test("main: a drifting rewrite still exits 1, so the two failures stay distinguishable", () => {
  const dir = mkdtempSync(join(tmpdir(), "simplify-verify-"));
  const originalPath = join(dir, "note.md");
  const rewritePath = join(dir, "rewrite.md");
  writeFileSync(originalPath, "# Title\n\nBody text here.\n");
  writeFileSync(rewritePath, "Body text here.\n"); // the heading is gone
  const proc = Bun.spawnSync([VERIFY_BIN, originalPath, rewritePath], { env: { ...process.env } });
  expect(proc.exitCode).toBe(1);
  expect(proc.stdout.toString()).toContain("- headings: DRIFT");
});
