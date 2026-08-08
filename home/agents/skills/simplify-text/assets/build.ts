#!/usr/bin/env bun
// simplify-text/assets/build — fill viewer.html with one pass and write the artifact page.
//
// This script exists for one line: MARKER_RE. Filling the markers with a sequence of plain
// replaces corrupts the page whenever the restyled document is ITSELF about the markers. This
// skill's own SKILL.md names `__ORIGINAL__` and `__EDITED__` in prose, so substituting
// `__ORIGINAL__` first injects a body carrying the literal `__EDITED__`, and the next substitution
// then writes into the text it had just inserted. One regex pass removes the class of bug:
// String.replace walks the template left to right and never re-reads a replacement it produced.
//
// Usage: bun build.ts <src-name> <original> <edited> <brief> <out>
//   src-name   the label shown in the header, e.g. a file path
//   original   file holding the source text, verbatim
//   edited     file holding the rewrite, the ## Rewrite block
//   brief      file holding the full CLI brief
//   out        the .html file to write, ready for the Artifact tool
//
// Exit: 0 wrote the page, 1 a marker was missing from the template, 2 usage.

const MARKERS = ["__SRC__", "__ORIGINAL__", "__EDITED__", "__BRIEF__"] as const;
type Marker = (typeof MARKERS)[number];

// Every alternative here has a MARKERS entry, and every MARKERS entry has an alternative. The
// `values` record below is typed on Marker, so TypeScript catches a drifting pair.
const MARKER_RE = /__(?:SRC|ORIGINAL|EDITED|BRIEF)__/g;

// Escape for element content, which is where all four fills land — three inside `<pre>`, one
// inside a `<span>`. No fill reaches an attribute, so quotes need no escape.
const escapeHtml = (s: string): string =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const [srcName, originalPath, editedPath, briefPath, outPath] = process.argv.slice(2);
if (!srcName || !originalPath || !editedPath || !briefPath || !outPath) {
  console.error("usage: bun build.ts <src-name> <original> <edited> <brief> <out>");
  process.exit(2);
}

const values: Record<Marker, string> = {
  __SRC__: escapeHtml(srcName),
  __ORIGINAL__: escapeHtml(await Bun.file(originalPath).text()),
  __EDITED__: escapeHtml(await Bun.file(editedPath).text()),
  __BRIEF__: escapeHtml(await Bun.file(briefPath).text()),
};

const template = await Bun.file(new URL("viewer.html", import.meta.url)).text();
const seen = new Set<string>();
const page = template.replace(MARKER_RE, (m) => {
  seen.add(m);
  return values[m as Marker];
});

// A marker the template never carried means the two files drifted apart. Fail loudly: a silently
// unfilled panel reads as an empty document, which looks like a legitimate result.
const missing = MARKERS.filter((m) => !seen.has(m));
if (missing.length > 0) {
  console.error(`markers never found in viewer.html: ${missing.join(", ")}`);
  process.exit(1);
}

await Bun.write(outPath, page);
console.log(`wrote ${outPath} (${(page.length / 1024).toFixed(1)} KB)`);
