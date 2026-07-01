// pure-helper tests — run with `bun test` from this directory.
//
// 17a split distill.ts into leaf modules whose helpers are pure string/data
// functions with no I/O. This suite pins those helpers directly now that they are
// importable: the text utilities (text.ts), the balanced-JSON extractor over loose
// model output (fw.ts::extractJson), and the distilled-body parser that render mode
// inverts the compress pipeline through (render-mode.ts::parseDistilled). It also
// pins the one hardening this step adds — parseDistilled drops a term row with no
// definition, malformed glossary output the model produced by splitting a row.
import { expect, test } from "bun:test";
import {
  detectLang,
  glossList,
  harvestBlockquotes,
  harvestCitations,
  harvestExternalLinks,
  harvestFences,
  harvestImages,
  harvestInternalLinks,
  harvestMath,
  harvestNumbers,
  harvestProseListItems,
  harvestTableRows,
  harvestVaultEdges,
  harvestWikilinks,
  hasOperational,
  normalizeForContainment,
  hasWikilink,
  isExternalUrl,
  isContentfulStep,
  formatDryRun,
  compactSection,
  reassembleNote,
  normalizeRelation,
  normalizeTypography,
  partition,
  payloadDensity,
  payloadMask,
  relText,
  routeNote,
  routeSection,
  sections,
  segment,
  slugSegment,
  wordCount,
} from "./text.ts";
import { extractJson } from "./fw.ts";
import { assembleRoutedNote, edgePayloadResidue, wikilinkResidue } from "./pipeline.ts";
import { parseDistilled } from "./render-mode.ts";
import { assembleBody, renderWorkflowBlock } from "./assemble.ts";

// ---- text.ts: segmentation ----
test("segment: splits on blank lines into B-indexed blocks", () => {
  expect(segment("para one\n\npara two")).toEqual([
    { id: "B1", text: "para one" },
    { id: "B2", text: "para two" },
  ]);
});

test("segment: a fenced code block stays one whole block, blank line included", () => {
  const blocks = segment("```\ncode\n\nmore\n```");
  expect(blocks).toHaveLength(1);
  expect(blocks[0].text).toBe("```\ncode\n\nmore\n```");
});

// ---- text.ts: per-section density router (D12) ----
test("routeSection: payload-dense routes to preserve, idea-dense to re-author", () => {
  const codeHeavy = [
    "## Usage",
    "",
    "```ts",
    "const router = createRouter();",
    "router.add('/a', handlerA);",
    "router.add('/b', handlerB);",
    "export default router.listen(3000);",
    "```",
  ].join("\n");
  expect(routeSection(codeHeavy)).toBe("preserve");

  const idea = [
    "## Thesis",
    "",
    "Distillation re-expresses a note as compact prose, collapsing many surface",
    "restatements of one idea into a single entry while keeping the thesis and the",
    "relations among the terms intact and readable.",
  ].join("\n");
  expect(routeSection(idea)).toBe("re-author");
});

test("routeSection: a table-dense section routes to preserve", () => {
  const tableHeavy = [
    "## Limits",
    "",
    "| Plan | Requests | Burst |",
    "| --- | --- | --- |",
    "| Free | 100 | 10 |",
    "| Pro | 10000 | 500 |",
    "| Enterprise | unlimited | custom |",
  ].join("\n");
  expect(routeSection(tableHeavy)).toBe("preserve");
});

test("routeSection: a blockquote-heavy section routes to preserve", () => {
  const quoteHeavy = [
    "## Source",
    "",
    "> The price of reliability is the pursuit of the utmost simplicity.",
    "> It is a price which the very rich find most hard to pay.",
    "> Simplicity and elegance are unpopular because they require hard work",
    "> and discipline to achieve and education to be appreciated.",
  ].join("\n");
  expect(routeSection(quoteHeavy)).toBe("preserve");
});

test("routeSection: a display-math / image-line section routes to preserve", () => {
  const mathHeavy = [
    "## Model",
    "",
    "![architecture diagram](https://example.com/arch.png)",
    "",
    "$$",
    "\\text{density} = \\frac{w - w_{\\text{mask}}}{w} \\geq \\tau",
    "$$",
  ].join("\n");
  expect(routeSection(mathHeavy)).toBe("preserve");
});

test("sections: splits on every ATX heading; lead is the intro section", () => {
  const note = ["intro paragraph", "", "# Top", "top body", "", "## Sub", "sub body"].join("\n");
  const secs = sections(note);
  expect(secs.map((s) => [s.heading, s.depth])).toEqual([
    ["", 0],
    ["Top", 1],
    ["Sub", 2],
  ]);
  expect(secs[0].text.trim()).toBe("intro paragraph"); // lead kept as intro
  expect(secs[1].text).toBe("# Top\ntop body\n"); // section text includes its own heading line
});

test("sections: a note opening on a heading has no intro section", () => {
  expect(sections("# Only\nbody").map((s) => s.heading)).toEqual(["Only"]);
});

test("sections: a `#`-comment inside a fenced code block is not a heading boundary", () => {
  const note = [
    "## First",
    "",
    "```bash",
    "# a comment that looks like a heading",
    "echo hi",
    "```",
    "",
    "## Second",
    "body",
  ].join("\n");
  const secs = sections(note);
  expect(secs.map((s) => s.heading)).toEqual(["First", "Second"]);
  expect(secs[0].text).toContain("# a comment that looks like a heading\necho hi");
});

test("sections + routeSection: a heterogeneous note routes per section (D12)", () => {
  const note = [
    "## Idea",
    "",
    "Distillation re-expresses a note as compact prose, collapsing many surface",
    "restatements of one idea into a single readable entry kept faithful to source.",
    "",
    "## Usage",
    "",
    "```ts",
    "const r = createRouter();",
    "r.add('/a', a);",
    "r.add('/b', b);",
    "```",
  ].join("\n");
  expect(sections(note).map((s) => routeSection(s.text))).toEqual(["re-author", "preserve"]);
});

test("payloadDensity: empty section is 0, all-payload section is ~1", () => {
  expect(payloadDensity("")).toBe(0);
  expect(payloadDensity("   \n  ")).toBe(0);
  expect(payloadDensity("```\nx\ny\nz\n```")).toBeGreaterThan(0.9);
});

test("routeNote: labels the intro and computes per-section density + route", () => {
  const note = ["lead text here", "", "## Code", "```", "x", "y", "```"].join("\n");
  const rows = routeNote(note);
  expect(rows.map((r) => [r.heading, r.route])).toEqual([
    ["", "re-author"],
    ["Code", "preserve"],
  ]);
});

test("formatDryRun: one note line with route-mix, one line per section", () => {
  const rows = [
    { heading: "Idea", depth: 2, density: 0, route: "re-author" as const },
    { heading: "Usage", depth: 2, density: 1, route: "preserve" as const },
  ];
  expect(formatDryRun("notes/x.md", rows)).toBe(
    [
      "notes/x.md · 1 re-author / 1 preserve",
      "  Idea · 0.00 · re-author",
      "  Usage · 1.00 · preserve",
    ].join("\n"),
  );
});

// ---- text.ts: per-section build partition (D12/D16; Backlog 10) ----
test("partition: extracts the H1 title and routes flat top-level units (fix #1)", () => {
  const note = [
    "# Homelab Guide",
    "",
    "A short intro paragraph explaining the overall setup in plain prose, carrying",
    "the reasoning rather than configuration the reader would only scan past.",
    "",
    "## Rationale",
    "",
    "We choose this approach because it keeps the surface small and lets the prose",
    "carry the reasoning instead of a wall of settings to read line by line.",
    "",
    "## Config",
    "",
    "```yaml",
    "service:",
    "  port: 8080",
    "  retries: 3",
    "```",
  ].join("\n");
  const { title, sections } = partition(note);
  expect(title).toBe("# Homelab Guide");
  expect(sections.map((u) => [u.heading, u.route])).toEqual([
    ["", "re-author"], // intro prose under the title
    ["Rationale", "re-author"],
    ["Config", "preserve"],
  ]);
  // the title line is lifted out — present in no section
  expect(sections.every((u) => !u.text.includes("# Homelab Guide"))).toBe(true);
  // the preserve section holds its code fence verbatim
  expect(sections[2].text).toContain("port: 8080");
});

test("partition: a payload subsection folds into its prose parent, not torn out (fix #2)", () => {
  const note = [
    "## Algorithm",
    "",
    "The router classifies each section by payload density and sends it to the surface",
    "that fits, re-authoring prose and holding payload so the note stays one coherent whole.",
    "",
    "### Pseudocode",
    "",
    "```",
    "for s in sections: route(s)",
    "```",
    "",
    "## Notes",
    "",
    "A closing remark in plain prose that simply restates the idea once more for the reader.",
  ].join("\n");
  const { sections } = partition(note);
  // the ### Pseudocode block stays inside the ## Algorithm section — two top-level sections, not three
  expect(sections.map((u) => u.heading)).toEqual(["Algorithm", "Notes"]);
  expect(sections[0].text).toContain("### Pseudocode");
  expect(sections[0].text).toContain("for s in sections");
  // the prose-dominated Algorithm subtree routes re-author as a whole
  expect(sections[0].route).toBe("re-author");
});

test("compactSection: v1 holds a payload section byte-verbatim (fix #3)", () => {
  const section = [
    "## Config",
    "",
    "```yaml",
    "service:",
    "  port: 8080",
    "  retries: 3",
    "```",
    "",
    "| metric | value |",
    "| ------ | ----- |",
    "| p99    | 12ms  |",
    "| p99    | 12ms  |",
  ].join("\n");
  // identity passthrough: no row-dedup, code + exact numbers untouched (the duplicate
  // p99 row survives — silent loss is the deferred v2's job, with surfacing)
  expect(compactSection(section)).toBe(section);
});

test("reassembleNote: title first, head, preserves in source order; demotes a colliding ## Glossary (fix #1/#4)", () => {
  const title = "# Homelab Guide";
  const head = [
    "Intro prose carrying the thesis.",
    "",
    "## Glossary",
    "",
    "| Term | Definition |",
    "| ---- | ---------- |",
    "| Router | routes sections |",
  ].join("\n");
  const preserves = [
    "## Config\n\n```yaml\nport: 8080\n```",
    "## Glossary\n\n| Term | Definition |\n| ---- | ---------- |\n| TTL | time to live |",
  ];
  const out = reassembleNote(title, head, preserves);
  // title is emitted first (fix #1)
  expect(out.startsWith("# Homelab Guide\n")).toBe(true);
  // exactly one H2 ## Glossary — the head's; the preserve's own glossary is demoted to ###
  expect(out.match(/^## Glossary$/gm)?.length).toBe(1);
  expect(out).toContain("### Glossary");
  // head before preserves; preserves kept in source order (fix #4: head-first, order among preserves)
  expect(out.indexOf("## Glossary")).toBeLessThan(out.indexOf("## Config"));
  expect(out.indexOf("## Config")).toBeLessThan(out.indexOf("### Glossary"));
  // payload held verbatim
  expect(out).toContain("port: 8080");
});

// ---- pipeline.ts: routed-build seam (distillRouted's no-LLM tail; Backlog 14/WorkStep-splice) ----
test("assembleRoutedNote: empty-head holds the preserve verbatim, reCount 0, no verbatim tag", () => {
  const r = assembleRoutedNote({
    source: "# T\n\n## Data\n\n`x`",
    title: "# T",
    reauthorText: "",
    head: { out: "", residue: [], status: "passthrough" },
    sections: [{ route: "preserve", text: "## Data\n\n`x`" }],
  });
  expect(r.out.startsWith("# T")).toBe(true);
  expect(r.out).toContain("`x`");
  expect(r.footer).toContain("0 re-author / 1 preserve");
  expect(r.footer).not.toContain("kept verbatim");
  expect(r.residue).toEqual([]);
});

test("assembleRoutedNote: all-preserve keeps both sections in source order, reCount 0, no tag", () => {
  const r = assembleRoutedNote({
    source: "## A\n\n`a`\n\n## B\n\n`b`",
    title: "",
    reauthorText: "",
    head: { out: "", residue: [], status: "passthrough" },
    sections: [
      { route: "preserve", text: "## A\n\n`a`" },
      { route: "preserve", text: "## B\n\n`b`" },
    ],
  });
  expect(r.footer).toContain("0 re-author / 2 preserve");
  expect(r.footer).not.toContain("kept verbatim");
  expect(r.out.indexOf("## A")).toBeLessThan(r.out.indexOf("## B"));
  expect(r.residue).toEqual([]);
});

test("assembleRoutedNote: title-less note emits head first with no leading title line", () => {
  const r = assembleRoutedNote({
    source: "## Idea\n\nidea\n\n## Data\n\n`x`",
    title: "",
    reauthorText: "## Idea\n\nidea",
    head: { out: "Head prose.", residue: [], status: "compressed" },
    sections: [
      { route: "re-author", text: "## Idea\n\nidea" },
      { route: "preserve", text: "## Data\n\n`x`" },
    ],
  });
  expect(r.out.startsWith("Head prose.")).toBe(true);
  expect(r.out).toContain("`x`");
  expect(r.footer).toContain("1 re-author / 1 preserve");
  expect(r.footer).not.toContain("kept verbatim");
});

test("assembleRoutedNote: link dropped from head but alive in a preserve section yields no residue (fix 1 scope)", () => {
  const source = "## Idea\n\nsee [[foo]]\n\n## Data\n\n`code` [[foo]]";
  const r = assembleRoutedNote({
    source,
    title: "",
    reauthorText: "## Idea\n\nsee [[foo]]",
    head: { out: "Idea prose, link gone.", residue: [], status: "compressed" },
    sections: [
      { route: "re-author", text: "## Idea\n\nsee [[foo]]" },
      { route: "preserve", text: "## Data\n\n`code` [[foo]]" },
    ],
  });
  // [[foo]] survives in the reassembled preserve, so the single whole-note run reads it
  // covered; at head scope it would have false-flagged a drop.
  expect(r.residue).toEqual([]);
  expect(r.footer).not.toContain("residue");
});

test("assembleRoutedNote: a genuinely dropped link surfaces exactly once, not double-counted (fix 1)", () => {
  const source = "## Idea\n\nsee [[bar]]\n\n## Data\n\n`code`";
  const r = assembleRoutedNote({
    source,
    title: "",
    reauthorText: "## Idea\n\nsee [[bar]]",
    head: { out: "Idea prose, link gone.", residue: [], status: "compressed" },
    sections: [
      { route: "re-author", text: "## Idea\n\nsee [[bar]]" },
      { route: "preserve", text: "## Data\n\n`code`" },
    ],
  });
  // head.residue is [] (post-fix the routed head no longer runs the edge gate), so the
  // whole-note run is the sole source — one residue, no double-count.
  expect(r.residue.length).toBe(1);
  expect(r.residue[0].label).toBe("[[bar]]");
  expect(r.footer).toContain("1 residue");
});

test("assembleRoutedNote: verbatim head passthrough tags the footer (fix 3)", () => {
  const rt = "## Notes\n\nshort prose";
  const r = assembleRoutedNote({
    source: "# T\n\n" + rt + "\n\n## Data\n\n`z`",
    title: "# T",
    reauthorText: rt,
    head: { out: rt, residue: [], status: "passthrough" },
    sections: [
      { route: "re-author", text: rt },
      { route: "preserve", text: "## Data\n\n`z`" },
    ],
  });
  expect(r.footer).toContain("head kept verbatim (prose not compressed)");
});

test("assembleRoutedNote: a compressed head is not tagged (fix 3 no false-positive)", () => {
  const r = assembleRoutedNote({
    source: "# T\n\n## Notes\n\nlong original prose\n\n## Data\n\n`z`",
    title: "# T",
    reauthorText: "## Notes\n\nlong original prose",
    head: { out: "Tight distilled prose.", residue: [], status: "compressed" },
    sections: [
      { route: "re-author", text: "## Notes\n\nlong original prose" },
      { route: "preserve", text: "## Data\n\n`z`" },
    ],
  });
  expect(r.footer).not.toContain("kept verbatim");
});

test("assembleRoutedNote: a passthrough head whose out differs from reauthorText still tags (status, not byte-compare)", () => {
  // The producer (distill) is the authority on whether the head compressed; the discriminant
  // reads its status, not byte-equality. A passthrough head can legitimately differ in bytes
  // (e.g. reauthorText carried a heading the empty-output guard stripped) — byte-compare misses it.
  const r = assembleRoutedNote({
    source: "# T\n\n## Notes\n\np\n\n## Data\n\n`z`",
    title: "# T",
    reauthorText: "## Notes\n\np",
    head: { out: "different bytes", residue: [], status: "passthrough" },
    sections: [
      { route: "re-author", text: "## Notes\n\np" },
      { route: "preserve", text: "## Data\n\n`z`" },
    ],
  });
  expect(r.footer).toContain("head kept verbatim (prose not compressed)");
});

test("assembleRoutedNote: a compressed head whose out equals reauthorText is not tagged (no byte-compare false-positive)", () => {
  // A genuinely compressed head can land byte-identical to its source (short note, tight rewrite);
  // byte-compare would falsely tag it "kept verbatim". The status read does not.
  const rt = "## Notes\n\nidentical";
  const r = assembleRoutedNote({
    source: "# T\n\n" + rt + "\n\n## Data\n\n`z`",
    title: "# T",
    reauthorText: rt,
    head: { out: rt, residue: [], status: "compressed" },
    sections: [
      { route: "re-author", text: rt },
      { route: "preserve", text: "## Data\n\n`z`" },
    ],
  });
  expect(r.footer).not.toContain("kept verbatim");
});

// ---- assembleRoutedNote: WorkStep splicing by originating section ----
test("assembleRoutedNote: a re-author section's steps splice in at its position, not before the preceding preserve", () => {
  // The regression fixture: §1 re-author (no steps), §2 preserve (fence), §3 re-author (2 steps).
  // Before the splice, ALL steps rode the head, landing before §2 no matter their source section.
  const r = assembleRoutedNote({
    source: "## One\n\nprose\n\n## Two\n\n```js\ncode\n```\n\n## Three\n\nsteps live here",
    title: "",
    reauthorText: "## One\n\nprose\n\n## Three\n\nsteps live here",
    head: { out: "Synthesized prose.", residue: [], status: "compressed", workflowByOwner: [[], ["step1", "step2"]] },
    sections: [
      { route: "re-author", text: "## One\n\nprose" },
      { route: "preserve", text: "## Two\n\n```js\ncode\n```" },
      { route: "re-author", text: "## Three\n\nsteps live here" },
    ],
  });
  const iHead = r.out.indexOf("Synthesized prose.");
  const iPreserve = r.out.indexOf("```js");
  const iWorkflow = r.out.indexOf("### Workflow");
  expect(iHead).toBeGreaterThanOrEqual(0);
  expect(iHead).toBeLessThan(iPreserve);
  expect(iPreserve).toBeLessThan(iWorkflow);
  expect(r.out).toContain("### Workflow\n\n1. step1\n2. step2");
  // exactly one Workflow fragment, demoted (no stray ## Workflow H2 anywhere)
  expect(r.out.match(/^## Workflow$/gm)).toBeNull();
  expect(r.out.match(/^### Workflow$/gm)?.length).toBe(1);
});

test("assembleRoutedNote: two re-author owners split by a preserve section each get their own fragment, numbering continues", () => {
  const r = assembleRoutedNote({
    source: "## A\n\nsteps A\n\n## B\n\n`code`\n\n## C\n\nsteps C",
    title: "",
    reauthorText: "## A\n\nsteps A\n\n## C\n\nsteps C",
    head: { out: "Prose.", residue: [], status: "compressed", workflowByOwner: [["stepA1", "stepA2"], ["stepC1"]] },
    sections: [
      { route: "re-author", text: "## A\n\nsteps A" },
      { route: "preserve", text: "## B\n\n`code`" },
      { route: "re-author", text: "## C\n\nsteps C" },
    ],
  });
  expect(r.out).toContain("### Workflow\n\n1. stepA1\n2. stepA2");
  expect(r.out).toContain("### Workflow\n\n3. stepC1");
  expect(r.out.indexOf("stepA1")).toBeLessThan(r.out.indexOf("`code`"));
  expect(r.out.indexOf("`code`")).toBeLessThan(r.out.indexOf("stepC1"));
});

test("assembleRoutedNote: two adjacent re-author owners (no intervening preserve) coalesce into one fragment", () => {
  const r = assembleRoutedNote({
    source: "## A\n\nsteps A\n\n## B\n\nsteps B\n\n## C\n\n`code`",
    title: "",
    reauthorText: "## A\n\nsteps A\n\n## B\n\nsteps B",
    head: { out: "Prose.", residue: [], status: "compressed", workflowByOwner: [["stepA"], ["stepB"]] },
    sections: [
      { route: "re-author", text: "## A\n\nsteps A" },
      { route: "re-author", text: "## B\n\nsteps B" },
      { route: "preserve", text: "## C\n\n`code`" },
    ],
  });
  expect(r.out.match(/### Workflow/g)?.length).toBe(1);
  expect(r.out).toContain("### Workflow\n\n1. stepA\n2. stepB");
});

test("assembleRoutedNote: an owner with zero steps contributes no fragment", () => {
  const r = assembleRoutedNote({
    source: "## A\n\nprose\n\n## B\n\n`code`",
    title: "",
    reauthorText: "## A\n\nprose",
    head: { out: "Prose.", residue: [], status: "compressed", workflowByOwner: [[]] },
    sections: [
      { route: "re-author", text: "## A\n\nprose" },
      { route: "preserve", text: "## B\n\n`code`" },
    ],
  });
  expect(r.out).not.toContain("Workflow");
});

test("assembleRoutedNote: an owner whose steps are all content-free renders no fragment", () => {
  const r = assembleRoutedNote({
    source: "## A\n\nprose\n\n## B\n\n`code`",
    title: "",
    reauthorText: "## A\n\nprose",
    head: { out: "Prose.", residue: [], status: "compressed", workflowByOwner: [["3."]] },
    sections: [
      { route: "re-author", text: "## A\n\nprose" },
      { route: "preserve", text: "## B\n\n`code`" },
    ],
  });
  expect(r.out).not.toContain("Workflow");
});

test("assembleRoutedNote: head.out bytes pass through unchanged (prose/Glossary/Relations shape untouched)", () => {
  const headOut = "Prose.\n\n## Glossary\n\n| Term | Definition |\n| ---- | ---------- |\n| X | def |";
  const r = assembleRoutedNote({
    source: "## A\n\nprose\n\n## B\n\n`code`",
    title: "",
    reauthorText: "## A\n\nprose",
    head: { out: headOut, residue: [], status: "compressed", workflowByOwner: [["step1"]] },
    sections: [
      { route: "re-author", text: "## A\n\nprose" },
      { route: "preserve", text: "## B\n\n`code`" },
    ],
  });
  expect(r.out).toContain(headOut);
});

test("edgePayloadResidue: a routed head contributes no edge/payload residue (the scope guard)", () => {
  const src = "see [[bar]]\n\n```js\nconst x = 1;\n```";
  const out = "tight prose, link and code gone";
  // routed head: assembleRoutedNote owns the single whole-note run, so the head skips it.
  // Deleting the routed-skip in edgePayloadResidue reddens this line.
  expect(edgePayloadResidue(src, out, true)).toEqual([]);
  // homogeneous build: the same drop surfaces (dropped link + dropped fence)
  const res = edgePayloadResidue(src, out, false);
  expect(res.some((r) => r.label === "[[bar]]")).toBe(true);
  expect(res.length).toBeGreaterThanOrEqual(2);
});

test("edgePayloadResidue: a covered link surfaces nothing (homogeneous build, default routed)", () => {
  expect(edgePayloadResidue("see [[bar]]", "still see [[bar]] here")).toEqual([]);
});

// ---- text.ts: small utilities ----
test("wordCount: whitespace-collapsed token count, empty is zero", () => {
  expect(wordCount("  hello   world ")).toBe(2);
  expect(wordCount("")).toBe(0);
  expect(wordCount("   ")).toBe(0);
});

test("glossList: renders `- term: def` lines", () => {
  expect(
    glossList([
      { term: "a", def: "x" },
      { term: "b", def: "y" },
    ]),
  ).toBe("- a: x\n- b: y");
});

test("hasWikilink: detects [[...]] and ![[...]] embeds", () => {
  expect(hasWikilink("see [[note]]")).toBe(true);
  expect(hasWikilink("embed ![[img]]")).toBe(true);
  expect(hasWikilink("plain prose")).toBe(false);
});

test("hasOperational: detects code, CLI flags, and paths", () => {
  expect(hasOperational("use `code` here")).toBe(true);
  expect(hasOperational("run --verbose")).toBe(true);
  expect(hasOperational("see /usr/bin/foo")).toBe(true);
  expect(hasOperational("plain prose only")).toBe(false);
});

// ---- text.ts: typographic normalization ----
test("normalizeTypography: maps typeset glyphs back to source ASCII", () => {
  expect(normalizeTypography("“hi” it’s")).toBe('"hi" it\'s');
  expect(normalizeTypography("done…")).toBe("done...");
  expect(normalizeTypography("1–2")).toBe("1-2"); // en dash → hyphen
});

test("normalizeTypography: an em dash becomes a spaced em dash without eating newlines", () => {
  expect(normalizeTypography("a—b")).toBe("a — b");
  expect(normalizeTypography("a—\nb")).toBe("a — \nb");
});

// ---- text.ts: slugging (Cyrillic survives; ASCII parity lives in distill.test.ts) ----
test("slugSegment: collapses Unicode-letter runs, keeping Cyrillic", () => {
  expect(slugSegment("Привет Мир")).toBe("привет-мир");
});

// ---- text.ts: relation coercion ----
test("normalizeRelation: lowercases + hyphenates rel, keeps a present predicate", () => {
  expect(normalizeRelation({ rel: "precondition for", to: "aim-point", predicate: "x" })).toEqual({
    rel: "precondition-for",
    to: "aim-point",
    predicate: "x",
  });
});

test("normalizeRelation: an empty predicate collapses to null", () => {
  expect(normalizeRelation({ rel: "subsumes", to: "holdover", predicate: "" })).toEqual({
    rel: "subsumes",
    to: "holdover",
    predicate: null,
  });
});

test("normalizeRelation: drops an edge missing rel or to, or a non-object", () => {
  expect(normalizeRelation({ to: "x" })).toBeNull();
  expect(normalizeRelation({ rel: "subsumes" })).toBeNull();
  expect(normalizeRelation(null)).toBeNull();
  expect(normalizeRelation("not an object")).toBeNull();
});

test("relText: renders `rel :: to` and appends a present predicate", () => {
  expect(relText({ rel: "subsumes", to: "holdover", predicate: null })).toBe(
    "subsumes :: holdover",
  );
  expect(relText({ rel: "depends-on", to: "x", predicate: "p" })).toBe("depends-on :: x (p)");
});

// ---- text.ts: language detection ----
test("detectLang: Cyrillic-majority is ru, Latin is en, letterless defaults to en", () => {
  expect(detectLang("hello world")).toBe("en");
  expect(detectLang("привет мир")).toBe("ru");
  expect(detectLang("123 !!!")).toBe("en");
});

// ---- fw.ts: balanced-JSON extraction over loose model output ----
test("extractJson: returns a clean object verbatim", () => {
  expect(extractJson('{"a":1}')).toBe('{"a":1}');
});

test("extractJson: pulls the first balanced object out of surrounding reasoning", () => {
  expect(extractJson('thinking... {"prose":"hi"} trailing text')).toBe('{"prose":"hi"}');
});

test("extractJson: respects nesting and braces inside strings", () => {
  expect(extractJson('x {"a":{"b":1}} y')).toBe('{"a":{"b":1}}');
  expect(extractJson('{"a":"}"}')).toBe('{"a":"}"}'); // brace in a string value
});

test("extractJson: throws on no object and on an unbalanced object", () => {
  expect(() => extractJson("no braces here")).toThrow(/no JSON/);
  expect(() => extractJson('{"a":1')).toThrow(/unbalanced JSON/);
});

// ---- render-mode.ts: parseDistilled ----
test("parseDistilled: splits tie, glossary entries, and skips header/separator rows", () => {
  const body = [
    "Tie-together prose line.",
    "",
    "## Glossary",
    "",
    "| Term | Definition |",
    "| --- | --- |",
    "| alpha | first letter |",
    "| beta | second letter |",
  ].join("\n");
  const { tie, entries, preserved } = parseDistilled(body);
  expect(tie).toBe("Tie-together prose line.");
  expect(entries).toEqual([
    { term: "alpha", def: "first letter" },
    { term: "beta", def: "second letter" },
  ]);
  expect(preserved).toBe("");
});

test("parseDistilled: preserves a ## Workflow section verbatim, never folds it into prose", () => {
  const body = [
    "Thesis prose.",
    "",
    "## Workflow",
    "",
    "- step one",
    "",
    "## Glossary",
    "",
    "| a | def a |",
  ].join("\n");
  const { tie, entries, preserved } = parseDistilled(body);
  expect(tie).toBe("Thesis prose.");
  expect(entries).toEqual([{ term: "a", def: "def a" }]);
  expect(preserved).toBe("## Workflow\n\n- step one");
});

test("parseDistilled: no ## Glossary table yields the whole body as tie, no entries", () => {
  const body = "Just prose.\n\n## Workflow\n\n- step";
  const { tie, entries, preserved } = parseDistilled(body);
  expect(tie).toBe("Just prose.\n\n## Workflow\n\n- step");
  expect(entries).toEqual([]);
  expect(preserved).toBe("");
});

test("parseDistilled: unescapes a \\| inside a definition cell", () => {
  const body = ["## Glossary", "", "| a | x \\| y |"].join("\n");
  const { entries } = parseDistilled(body);
  expect(entries).toEqual([{ term: "a", def: "x | y" }]);
});

// ---- render-mode.ts: parseDistilled hardening (this step) ----
test("parseDistilled: drops a malformed row whose definition cell is empty", () => {
  const body = ["## Glossary", "", "| alpha | first |", "| beta | |"].join("\n");
  const { entries } = parseDistilled(body);
  // beta has no definition (the model split or dropped a row) — skipped, not
  // emitted as an empty-def entry into the render prompt.
  expect(entries).toEqual([{ term: "alpha", def: "first" }]);
});

test("parseDistilled: a single-cell row (no definition column) is skipped, not a crash", () => {
  const body = ["## Glossary", "", "| gamma |", "| delta | real def |"].join("\n");
  const { entries } = parseDistilled(body);
  expect(entries).toEqual([{ term: "delta", def: "real def" }]);
});

test("harvestWikilinks: extracts targets as slugs, strips alias and embed syntax", () => {
  // ITEM B: ![[img.png]] is an asset embed (renders inline), not an edge — it is now
  // EXCLUDED. The surviving real edges carry the alias-stripped raw target.
  expect(
    harvestWikilinks("see [[30 notes/Elegant solution]] and ![[img.png]] and [[Foo|bar]]"),
  ).toEqual([
    {
      markup: "[[30 notes/Elegant solution]]",
      slug: "30-notes-elegant-solution",
      target: "30 notes/Elegant solution",
    },
    { markup: "[[Foo|bar]]", slug: "foo", target: "Foo" },
  ]);
});

test("harvestWikilinks: plain prose yields nothing", () => {
  expect(harvestWikilinks("no links here")).toEqual([]);
});

// ---- text.ts: ITEM B — asset embeds are not vault edges ----
test("harvestWikilinks: asset embed ![[diagram.png]] is not an edge", () => {
  expect(harvestWikilinks("![[diagram.png]]")).toEqual([]);
});

test("harvestWikilinks: note transclusion ![[some-note]] stays an edge", () => {
  expect(harvestWikilinks("![[some-note]]")).toEqual([
    { markup: "![[some-note]]", slug: "some-note", target: "some-note" },
  ]);
});

test("harvestWikilinks: bare [[chart.png]] (no ! embed) stays an edge", () => {
  expect(harvestWikilinks("[[chart.png]]")).toEqual([
    { markup: "[[chart.png]]", slug: "chart-png", target: "chart.png" },
  ]);
});

test("harvestWikilinks: asset ext match is case-insensitive", () => {
  expect(harvestWikilinks("![[Photo.JPG]]")).toEqual([]);
});

test("harvestWikilinks: alias is stripped before the asset test", () => {
  // target = "diagram.png" after split("|")[0], so the embed is excluded — proves
  // ASSET_RE runs on the alias-stripped target, not the raw inner text.
  expect(harvestWikilinks("![[diagram.png|caption]]")).toEqual([]);
});

test("harvestWikilinks: pdf and av embeds are excluded", () => {
  expect(harvestWikilinks("![[clip.mp4]] ![[doc.pdf]] ![[song.mp3]]")).toEqual([]);
});

test("harvestWikilinks: a fragment-bearing asset embed is still excluded", () => {
  // ASSET_RE is `$`-anchored; the asset test runs on the fragment-stripped target so a
  // page/section embed is caught despite the trailing #fragment.
  expect(harvestWikilinks("![[doc.pdf#page=2]] and ![[image.png#small]]")).toEqual([]);
});

test("harvestWikilinks: a fragment-bearing note transclusion stays an edge, slug drops the fragment", () => {
  // not an asset, so it survives; normalizeEdgeTarget strips the #fragment before
  // slugging, so the anchored form unifies on slug `some-note` with the bare `[[some-note]]`.
  expect(harvestWikilinks("![[some-note#heading]]")).toEqual([
    { markup: "![[some-note#heading]]", slug: "some-note", target: "some-note" },
  ]);
});

// ---- text.ts: CHANGE #1 — normalizeEdgeTarget unifies anchored and bare edges ----
test("harvestWikilinks: a fragment-bearing wikilink [[note#heading]] harvests slug `note`", () => {
  expect(harvestWikilinks("[[note#heading]]")).toEqual([
    { markup: "[[note#heading]]", slug: "note", target: "note" },
  ]);
});

test("harvestVaultEdges: [[note#heading]] and [x](note.md#heading) both harvest slug `note`", () => {
  expect(harvestVaultEdges("[[note#heading]] and [x](note.md#heading)")).toEqual([
    { markup: "[[note#heading]]", slug: "note", target: "note" },
    { markup: "[x](note.md#heading)", slug: "note", target: "note" },
  ]);
});

// ---- text.ts: external-link harvest (the citation lane, D38) ----
test("harvestExternalLinks: collects [text](url) with text+url, strips a title suffix", () => {
  expect(
    harvestExternalLinks('see [Pólya](https://x.test/heuristic) and [t](http://y.test "title")'),
  ).toEqual([
    { markup: "[Pólya](https://x.test/heuristic)", text: "Pólya", url: "https://x.test/heuristic" },
    { markup: '[t](http://y.test "title")', text: "t", url: "http://y.test" },
  ]);
});

test("harvestExternalLinks: excludes images and [[wikilinks]]", () => {
  // ![alt](url) is an image (lookbehind on !), [[wiki]] has no (url) to match.
  expect(harvestExternalLinks("![logo](img.png) and [[a/B]] and [[Foo|bar]]")).toEqual([]);
});

test("harvestExternalLinks: plain prose and bare wikilinks yield nothing", () => {
  expect(harvestExternalLinks("no links, just [[a wikilink]] here")).toEqual([]);
});

test("harvestWikilinks: a pre-slugged ## Relations endpoint is idempotent", () => {
  // emitRelationsBlock emits [[30-notes-elegant-solution]]; harvesting it must yield
  // the SAME slug as the source [[30 notes/Elegant solution]], so coverage matches.
  expect(harvestWikilinks("[[30-notes-elegant-solution]]")[0].slug).toBe(
    "30-notes-elegant-solution",
  );
});

// ---- text.ts: ITEM C — internal markdown links are vault edges ----
test("harvestExternalLinks: excludes a scheme-less [x](foo.md) (now a vault edge)", () => {
  expect(harvestExternalLinks("[x](foo.md)")).toEqual([]);
});

test("harvestExternalLinks: keeps mailto and protocol-relative urls", () => {
  expect(harvestExternalLinks("[m](mailto:a@b.test) and [r](//cdn.test/p)")).toEqual([
    { markup: "[m](mailto:a@b.test)", text: "m", url: "mailto:a@b.test" },
    { markup: "[r](//cdn.test/p)", text: "r", url: "//cdn.test/p" },
  ]);
});

test("isExternalUrl: classifies schemes and protocol-relative as external", () => {
  expect(isExternalUrl("https://x")).toBe(true);
  expect(isExternalUrl("mailto:a")).toBe(true);
  expect(isExternalUrl("//h")).toBe(true);
  expect(isExternalUrl("foo.md")).toBe(false);
  expect(isExternalUrl("./x")).toBe(false);
  expect(isExternalUrl("#a")).toBe(false);
});

test("harvestInternalLinks: slugs a %20-encoded relative .md path", () => {
  // the shared [^)\s]+ grammar forbids a literal space, so a spaced path is %20-encoded;
  // the decode step restores it before slugging.
  expect(harvestInternalLinks("[x](30%20notes/Elegant%20solution.md)")).toEqual([
    {
      markup: "[x](30%20notes/Elegant%20solution.md)",
      slug: "30-notes-elegant-solution",
      target: "30 notes/Elegant solution",
    },
  ]);
});

test("harvestInternalLinks: strips a leading ./", () => {
  expect(harvestInternalLinks("[r](./folder/note.md)")).toEqual([
    { markup: "[r](./folder/note.md)", slug: "folder-note", target: "folder/note" },
  ]);
});

test("harvestInternalLinks: skips an external url", () => {
  expect(harvestInternalLinks("[x](https://e.test)")).toEqual([]);
});

test("harvestInternalLinks: skips an asset link", () => {
  expect(harvestInternalLinks("[c](chart.png)")).toEqual([]);
});

test("harvestInternalLinks: skips a bare #anchor", () => {
  expect(harvestInternalLinks("[a](#sec)")).toEqual([]);
});

test("harvestVaultEdges: unions wikilinks and internal markdown links", () => {
  expect(harvestVaultEdges("[[foo]] and [b](bar.md)")).toEqual([
    { markup: "[[foo]]", slug: "foo", target: "foo" },
    { markup: "[b](bar.md)", slug: "bar", target: "bar" },
  ]);
});

// ---- pipeline.ts: wikilinkResidue — ITEM A (collision) + ITEM B/C (lanes) ----
test("wikilinkResidue: alias pair [[foo]] + [[foo|alias]] uncovered → ONE dropped residue", () => {
  const r = wikilinkResidue("see [[foo]] and [[foo|alias]]", "");
  expect(r.length).toBe(1);
  expect(r[0].label).toBe("[[foo]]");
  expect(r[0].reason).toMatch(/^wikilink dropped/);
  expect(r[0].reason).not.toMatch(/collision/);
});

test("wikilinkResidue: alias pair covered by [[foo]] → no residue", () => {
  expect(wikilinkResidue("see [[foo]] and [[foo|alias]]", "[[foo]]")).toEqual([]);
});

test("wikilinkResidue: genuine [[foo bar]] + [[foo/bar]] → collision over both, even when covered", () => {
  const r = wikilinkResidue("[[foo bar]] and [[foo/bar]]", "[[foo-bar]]");
  expect(r.map((x) => x.label)).toEqual(["[[foo bar]]", "[[foo/bar]]"]);
  for (const x of r) expect(x.reason).toMatch(/slug-collision/);
});

test("wikilinkResidue: case-only [[Foo]] + [[foo]] → collapses, one dropped, no collision", () => {
  const r = wikilinkResidue("[[Foo]] and [[foo]]", "");
  expect(r.length).toBe(1);
  expect(r[0].label).toBe("[[Foo]]");
  expect(r[0].reason).toMatch(/^wikilink dropped/);
  expect(r[0].reason).not.toMatch(/collision/);
});

test("wikilinkResidue: three same-target spellings collapse to one dropped residue", () => {
  const r = wikilinkResidue("[[foo]] [[foo|x]] [[Foo]]", "");
  expect(r.length).toBe(1);
  expect(r[0].label).toBe("[[foo]]");
});

test("wikilinkResidue: distinct slugs [[a]] + [[b]] → two dropped, no collision", () => {
  const r = wikilinkResidue("[[a]] and [[b]]", "");
  expect(r.map((x) => x.label)).toEqual(["[[a]]", "[[b]]"]);
  for (const x of r) expect(x.reason).toMatch(/^wikilink dropped/);
});

test("wikilinkResidue: 2 distinct targets over 3 markups → collision pushes all three markups", () => {
  const r = wikilinkResidue("[[foo bar]] [[foo bar|x]] [[foo/bar]]", "");
  expect(r.map((x) => x.label)).toEqual(["[[foo bar]]", "[[foo bar|x]]", "[[foo/bar]]"]);
  for (const x of r) expect(x.reason).toMatch(/slug-collision/);
});

test("wikilinkResidue: cross-lane [[foo]] + [foo](foo.md) same note → not a collision", () => {
  // both denote note 'foo' with normalized target 'foo' — one distinct target, covered.
  expect(wikilinkResidue("[[foo]] and [foo](foo.md)", "see [[foo]]")).toEqual([]);
});

test("wikilinkResidue: a dropped internal link [x](foo.md) surfaces as residue", () => {
  const r = wikilinkResidue("[x](foo.md)", "");
  expect(r.length).toBe(1);
  expect(r[0].label).toBe("[x](foo.md)");
  expect(r[0].reason).toMatch(/dropped/);
});

test("wikilinkResidue: an internal link covered by a wikilink in output is not residue", () => {
  expect(wikilinkResidue("[x](foo.md)", "see [[foo]]")).toEqual([]);
});

test("wikilinkResidue: a dropped asset embed ![[diagram.png]] yields no residue", () => {
  expect(wikilinkResidue("![[diagram.png]]", "")).toEqual([]);
});

test("wikilinkResidue: a dropped note transclusion ![[some-note]] still surfaces", () => {
  const r = wikilinkResidue("![[some-note]]", "");
  expect(r.length).toBe(1);
  expect(r[0].label).toBe("![[some-note]]");
  expect(r[0].reason).toMatch(/dropped/);
});

test("wikilinkResidue: a dropped bare [[img.png]] still surfaces (no ! embed)", () => {
  const r = wikilinkResidue("[[img.png]]", "");
  expect(r.length).toBe(1);
  expect(r[0].label).toBe("[[img.png]]");
});

test("wikilinkResidue: an asset embed covered nowhere is still not residue", () => {
  expect(wikilinkResidue("text ![[diagram.png]] more", "text more")).toEqual([]);
});

test("wikilinkResidue: an asset-extension markdown link is not an edge", () => {
  expect(wikilinkResidue("[chart](chart.png)", "")).toEqual([]);
});

// ---- pipeline.ts: CHANGE #1 — fragment strip kills the anchor-downgrade false positive ----
test("wikilinkResidue: source [[note#heading]] covered by output [[note]] yields no residue", () => {
  // both slug to `note` now (normalizeEdgeTarget strips the anchor before slugging), so
  // the output's bare link covers the source's anchored one — no false-positive residue.
  expect(wikilinkResidue("see [[note#heading]]", "see [[note]]")).toEqual([]);
});

test("wikilinkResidue: a dropped [[dropped]] absent from output STILL surfaces (safety net intact)", () => {
  const r = wikilinkResidue("see [[dropped]]", "no links here");
  expect(r.length).toBe(1);
  expect(r[0].label).toBe("[[dropped]]");
  expect(r[0].reason).toMatch(/^wikilink dropped/);
});

// ---- payload harvesters: the non-edge, non-prose loss surface ----

test("harvestFences: keys the body, ignoring the language tag and fence width", () => {
  const a = harvestFences("```js\nconst x = 1;\n```");
  const b = harvestFences("````\nconst x = 1;\n````");
  expect(a).toHaveLength(1);
  expect(a[0].key).toBe("const x = 1;");
  expect(b[0].key).toBe(a[0].key); // info-string + fence width excluded from the key
});

test("harvestFences: internal indentation is load-bearing (kept in the key)", () => {
  const a = harvestFences("```\n  indented\n```");
  const b = harvestFences("```\nindented\n```");
  expect(a[0].key).not.toBe(b[0].key);
});

test("harvestBlockquotes: a quote keys its inner text, lowercased and whitespace-collapsed", () => {
  const r = harvestBlockquotes("> The sum of\n> the parts.\n\nprose");
  expect(r).toHaveLength(1);
  expect(r[0].key).toBe("the sum of the parts.");
});

test("harvestTableRows: data rows key their cells; the delimiter row is skipped", () => {
  const t = "| Sign | Defect |\n| --- | --- |\n| a | b |\n| c | d |";
  const keys = harvestTableRows(t).map((r) => r.key);
  expect(keys).toEqual(["sign␟defect", "a␟b", "c␟d"]);
});

test("harvestTableRows: a wikilink-alias pipe in prose is not mistaken for a table row", () => {
  expect(harvestTableRows("see [[Foo|bar]] and [[Baz|qux]] here")).toEqual([]);
});

test("harvestImages: a markdown image and an asset embed each key by target slug", () => {
  const r = harvestImages("![alt](diagram.png) and ![[Service locator.jpeg]]");
  expect(r.map((x) => x.key).sort()).toEqual(["diagram-png", "service-locator-jpeg"]);
});

test("harvestImages: a non-asset transclusion ![[some-note]] is not an image", () => {
  expect(harvestImages("![[some-note]]")).toEqual([]);
});

test("harvestMath: display math keys its symbols; inline currency is not a formula", () => {
  expect(harvestMath("$$N \\le c$$").map((x) => x.key)).toEqual(["n\\lec"]);
  expect(harvestMath("it cost $5 and saved $10 overall")).toEqual([]);
});

test("harvestMath: inline $…$ with an operator is a formula", () => {
  expect(harvestMath("the bound $a < b$ holds").map((x) => x.key)).toEqual(["a<b"]);
});

test("harvestCitations: markdown, footnote-definition, and bare URLs all surface", () => {
  const src =
    "see [docs](https://a.example/x) and bare https://b.example/y\n\n[^c]: https://c.example/z";
  const keys = harvestCitations(src).map((r) => r.key);
  expect(keys).toContain("https://a.example/x");
  expect(keys).toContain("https://b.example/y");
  expect(keys).toContain("https://c.example/z");
});

test("harvestNumbers: keeps substantive figures and a multiplier, drops idiom and bare years", () => {
  const keys = harvestNumbers(
    "CISQ put it at $1.52 trillion, churn 47% with an 8x rise since 2024; see step 1 and v2",
  ).map((r) => r.key);
  expect(keys).toContain("1.52"); // $ + decimal
  expect(keys).toContain("47%"); // percent
  expect(keys).toContain("8x"); // multiplier
  expect(keys).not.toContain("2024"); // bare year, no scale word
  expect(keys).not.toContain("1"); // 'step 1' single digit
  expect(keys).not.toContain("2"); // 'v2' single digit
});

test("harvestNumbers: digits inside a URL or footnote definition are not phantom statistics", () => {
  expect(harvestNumbers("ref https://x.example/2014/390755 here")).toEqual([]);
  expect(harvestNumbers("[^a]: https://x.example/2010/22795459")).toEqual([]);
});

test("harvestNumbers: comma-grouped and plain forms share a key", () => {
  expect(harvestNumbers("1,200 items").map((r) => r.key)).toEqual(["1200"]);
});

// ---- harvestProseListItems: the prose-judge inventory (D46) ----
test("normalizeForContainment: lowercases, strips markdown punctuation, collapses whitespace", () => {
  expect(normalizeForContainment("  **Foo**  `bar`  (Baz)!  ")).toBe("foo bar baz");
});

test("harvestProseListItems: list-items under a depth≥2 heading become per-item units", () => {
  const src = [
    "# Title",
    "",
    "## OCP",
    "",
    "#### Признаки нарушения",
    "",
    "- coupling through concrete classes instead of interfaces",
    "- using singletons raises coupling far too high",
  ].join("\n");
  const units = harvestProseListItems(src, []);
  expect(units).toHaveLength(2);
  expect(units[0].id).toBe("признаки-нарушения-0");
  expect(units[1].id).toBe("признаки-нарушения-1");
  expect(units[0].depth).toBe(4);
});

test("harvestProseListItems: a lead item before the first heading is excluded (EXCL-1)", () => {
  const src =
    "# Title\n\n- a lead bullet with no owning section heading above\n\n## Sec\n\n- a real item under the section heading line";
  const units = harvestProseListItems(src, []);
  expect(units).toHaveLength(1);
  expect(units[0].id).toBe("sec-0");
});

test("harvestProseListItems: a payload-only bullet (wikilink / image) is excluded (EXCL-2)", () => {
  const src =
    "## Sec\n\n- [[some/other-note|an alias]]\n- ![[diagram.png]]\n- a genuine prose claim that must be covered";
  const units = harvestProseListItems(src, []);
  expect(units).toHaveLength(1);
  expect(units[0].span).toContain("genuine prose claim");
});

test("harvestProseListItems: an item folded into a claimed def/step is excluded (EXCL-3)", () => {
  const src =
    "## Sec\n\n- weaken preconditions in a subtype, never strengthen them\n- a different uncovered claim about class invariants";
  const claimed = ["source: weaken preconditions in a subtype, never strengthen them, per LSP"];
  const units = harvestProseListItems(src, claimed);
  expect(units).toHaveLength(1);
  expect(units.map((u) => u.span).join(" ")).not.toContain("weaken preconditions");
});

test("harvestProseListItems: a too-thin bullet is excluded (EXCL-4)", () => {
  const src = "## Sec\n\n- ok\n- a substantive enumerated claim long enough to carry meaning";
  const units = harvestProseListItems(src, []);
  expect(units).toHaveLength(1);
});

test("harvestProseListItems: a wrapped item folds continuation lines into one span", () => {
  const src =
    "## Sec\n\n- first part of the claim\n  and its indented continuation line\n- second independent claim about something";
  const units = harvestProseListItems(src, []);
  expect(units).toHaveLength(2);
  expect(units[0].span).toContain("continuation line");
});

test("harvestProseListItems: identical headings yield distinct per-item ids (collision proof)", () => {
  const src =
    "## A\n\n#### Итого\n\n- first summary point worth keeping around\n\n## B\n\n#### Итого\n\n- second summary point worth keeping too";
  const units = harvestProseListItems(src, []);
  expect(units).toHaveLength(2);
  expect(units[0].id).toBe("итого-0");
  expect(units[1].id).toBe("итого-1");
});

test("harvestProseListItems: a list-looking line inside a code fence is not inventoried", () => {
  const src =
    "## Sec\n\n```\n- this is code, not a prose list item to cover\n```\n\n- a real prose claim outside the fence here";
  const units = harvestProseListItems(src, []);
  expect(units).toHaveLength(1);
  expect(units[0].span).toContain("real prose claim");
});

test("harvestProseListItems: enum markers (F1. / A)) are recognized as list items", () => {
  const src =
    "## Moats\n\nF1. the first structural moat that filters competitors out\nA) the first scenario branch worth enumerating";
  const units = harvestProseListItems(src, []);
  expect(units).toHaveLength(2);
});

// ---- text.ts: workflow-step content guard (a model echoing a list ordinal as the step) ----
test("isContentfulStep: a marker-only token (an echoed ordinal) carries no content", () => {
  for (const empty of ["", "  ", "3.", "3", "1)", "-", "*", "#", " 4) "]) {
    expect(isContentfulStep(empty)).toBe(false);
  }
  for (const real of [
    "Tune the detector for recall",
    "3x faster on the hot path",
    "run `bun test`",
  ]) {
    expect(isContentfulStep(real)).toBe(true);
  }
});

test("assembleBody: a content-free workflow step is dropped and the rest renumbered", () => {
  // regression: the model returned "3." as a tightened step; the old filter(Boolean) kept it,
  // rendering "3. 3.". The content guard drops it and renumbers over what remains.
  const out = assembleBody(
    "",
    "",
    ["Emit a certificate", "3.", "Tune for recall"],
    [],
    new Map(),
    [],
    false,
  );
  expect(out).toContain("## Workflow\n\n1. Emit a certificate\n2. Tune for recall");
  expect(out).not.toContain("3. 3.");
});

test("renderWorkflowBlock: numbers from a given start, filtering content-free steps", () => {
  expect(renderWorkflowBlock(["a", "b"], 5)).toEqual({
    text: "## Workflow\n\n5. a\n6. b",
    count: 2,
  });
});

test("renderWorkflowBlock: no contentful steps yields an empty render and zero count", () => {
  expect(renderWorkflowBlock([], 1)).toEqual({ text: "", count: 0 });
  expect(renderWorkflowBlock(["3."], 1)).toEqual({ text: "", count: 0 });
});
