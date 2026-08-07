#!/usr/bin/env bun
// simplify-verify — the deterministic apply-gate for a Simplified restyle. See the USAGE block
// below for the CLI surface (invocation, output contract, exit codes).
//
// This is the verify half of `apply-mask-verify`. The simplify-text CLI (simplify.ts) covers the
// model-and-unmask stretch with its advisory `## guard`. This tool covers the stretch after: the
// subagent extracts the `## rewrite` block from the brief and is about to write it over the user's
// real note. That one edit is unverified, and its likely failure — a nested ``` fence truncating a
// naive extractor mid-block — drops content that trips no name typo. So the gate compares the
// extracted rewrite against the original on two deterministic axes and, unlike the CLI guard, exits
// NONZERO on drift: the apply mutates a real file, so a shipped corruption is permanent.
//
//   spans      — the reference-span multiset ([[wikilinks]], ![[embeds]], inline code, via the
//                CLI's own MASK_RE) is identical. A dropped, mutated, or invented span is drift.
//   structure  — the heading count, the fenced-code-marker count, AND the thematic-break (`---`)
//                count match. A truncation that drops no span still drops a heading, an opening
//                fence, or a `---` separator a template requires, so this is the backstop for a
//                pure-prose note the span axis cannot check.
//
// No model, no key, no network — the spans and structure markers are the certificate, and checking
// them is format validation. (Not core/writing/verify.ts, which is verifySpellBlock, the CLI-side
// block verifier for a change-nothing-else pass. This gate is skill-side and fires on a heavy
// restyle's applied output.)
import { readFileSync } from "node:fs";
import { parseFrontmatter } from "textkit/core/frontmatter.ts";
import {
  type FenceState,
  MASK_RE,
  THEMATIC_BREAK_RE,
  fenceScan,
  stripFences,
} from "textkit/core/text.ts";

// ---- the two axes (pure) ----

// One reference-span multiset diff: `original`/`rewrite` are the span counts on each side, and
// `dropped`/`invented` list the exact spans that fail to balance (with multiplicity), so the report
// names each rather than only counting. `ok` when both lists are empty. Internal — only VerifyReport
// (the exported shape) references it.
type SpanDiff = {
  ok: boolean;
  original: number;
  rewrite: number;
  dropped: string[];
  invented: string[];
};

// One structural-count axis (headings or fences): the count on each side and whether they match.
// Internal — VerifyReport reuses it for both count axes.
type CountAxis = { ok: boolean; original: number; rewrite: number };

// The full verify outcome — the span axis plus the three structural-count axes. verifyClean reads
// it to the single gate bit; formatVerify renders it to the report.
export type VerifyReport = {
  spans: SpanDiff;
  headings: CountAxis;
  fences: CountAxis;
  thematic: CountAxis;
};

// The reference spans MASK_RE finds in a text, in document order. `.match` with the shared global
// regex resets its lastIndex and returns every match (mask.ts relies on the same idiom), so reusing
// the CLI's own MASK_RE is safe and keeps the gate's span definition identical to what it masks.
const spanList = (text: string): string[] => text.match(MASK_RE) ?? [];

// The multiset difference of two span lists: spans present more often in `a` than `b` are `dropped`;
// spans present more often in `b` than `a` are `invented`. A mutated span shows as one dropped
// original and one invented replacement — the two lists name both halves, which is the exact report.
function multisetDiff(a: string[], b: string[]): { dropped: string[]; invented: string[] } {
  const tally = (xs: string[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
    return m;
  };
  const ca = tally(a);
  const cb = tally(b);
  const dropped: string[] = [];
  const invented: string[] = [];
  for (const [x, n] of ca) for (let i = 0; i < n - (cb.get(x) ?? 0); i++) dropped.push(x);
  for (const [x, n] of cb) for (let i = 0; i < n - (ca.get(x) ?? 0); i++) invented.push(x);
  return { dropped, invented };
}

// Count ATX headings outside fenced code: stripFences blanks every fence region line-for-line, so a
// `#`-prefixed comment inside a ```bash block is not miscounted. Up to three leading spaces and a
// `#`..`######` run followed by a space or end-of-line is a heading (CommonMark). The count is only
// ever COMPARED between the two sides, so a symmetric false positive (a `#` in verbatim frontmatter
// on both sides) cancels — the delta is what gates.
function headingCount(text: string): number {
  let n = 0;
  for (const line of stripFences(text).split("\n")) if (/^ {0,3}#{1,6}(?:\s|$)/.test(line)) n++;
  return n;
}

// Count fenced-code marker lines (each ``` / ~~~ opener AND closer) via the latching scanner, so an
// opposite-marker run inside a fence is literal content, not a marker. A whole block is two markers;
// a truncation that eats a block's closer leaves one — an odd delta the count catches.
function fenceMarkers(text: string): number {
  let n = 0;
  let fence: FenceState = null;
  for (const line of text.split("\n")) {
    const scan = fenceScan(line, fence);
    fence = scan.fence;
    if (scan.isMarker) n++;
  }
  return n;
}

// Count thematic-break lines (`---`, `***`, `___`) outside fenced code and outside the leading
// frontmatter block. parseFrontmatter drops the note's `---`-fenced YAML so its delimiters are not
// miscounted as breaks; stripFences then blanks a `---` inside a ```code block. Like headingCount,
// the number is only ever COMPARED between the two sides, so a symmetric count (a setext `---`
// underline present on both) cancels — the delta is what gates. A dropped `---` separator (the
// gh-stack footer rule a template needs) is the drift this axis catches.
function thematicBreakCount(text: string): number {
  let n = 0;
  for (const line of stripFences(parseFrontmatter(text).body).split("\n"))
    if (THEMATIC_BREAK_RE.test(line)) n++;
  return n;
}

// verify compares the proposed `rewrite` against the `original` note on every axis and returns the
// combined report. Pure and total — it reads two strings and touches no process state.
export function verify(original: string, rewrite: string): VerifyReport {
  const so = spanList(original);
  const sr = spanList(rewrite);
  const { dropped, invented } = multisetDiff(so, sr);
  const ho = headingCount(original);
  const hr = headingCount(rewrite);
  const fo = fenceMarkers(original);
  const fr = fenceMarkers(rewrite);
  const to = thematicBreakCount(original);
  const tr = thematicBreakCount(rewrite);
  return {
    spans: {
      ok: dropped.length === 0 && invented.length === 0,
      original: so.length,
      rewrite: sr.length,
      dropped,
      invented,
    },
    headings: { ok: ho === hr, original: ho, rewrite: hr },
    fences: { ok: fo === fr, original: fo, rewrite: fr },
    thematic: { ok: to === tr, original: to, rewrite: tr },
  };
}

// verifyClean reports whether every axis matched — the single gate bit. main exits 1 when false.
export function verifyClean(r: VerifyReport): boolean {
  return r.spans.ok && r.headings.ok && r.fences.ok && r.thematic.ok;
}

// formatVerify renders the report to the stdout body: one line per axis, each OK or DRIFT. A DRIFT
// line names the offending spans or the mismatched counts, so the subagent can surface the exact
// cause in its approval prompt.
export function formatVerify(r: VerifyReport): string {
  const lines: string[] = [];
  if (r.spans.ok) {
    lines.push(`- spans: OK — ${r.spans.original} reference span(s) preserved`);
  } else {
    const parts: string[] = [];
    if (r.spans.dropped.length)
      parts.push(`${r.spans.dropped.length} dropped (${r.spans.dropped.join(", ")})`);
    if (r.spans.invented.length)
      parts.push(`${r.spans.invented.length} invented (${r.spans.invented.join(", ")})`);
    lines.push(`- spans: DRIFT — ${parts.join("; ")}`);
  }
  lines.push(
    r.headings.ok
      ? `- headings: OK — ${r.headings.original} preserved`
      : `- headings: DRIFT — ${r.headings.original} in source, ${r.headings.rewrite} in rewrite`,
  );
  lines.push(
    r.fences.ok
      ? `- fences: OK — ${r.fences.original} marker(s) preserved`
      : `- fences: DRIFT — ${r.fences.original} marker(s) in source, ${r.fences.rewrite} in rewrite`,
  );
  lines.push(
    r.thematic.ok
      ? `- thematic breaks: OK — ${r.thematic.original} preserved`
      : `- thematic breaks: DRIFT — ${r.thematic.original} in source, ${r.thematic.rewrite} in rewrite`,
  );
  return lines.join("\n");
}

// ---- CLI surface ----

// USAGE is the full `--help` text: invocation forms, the output contract, and the exit codes — the
// human-facing counterpart to parseArgs.
export const USAGE = `simplify-verify — deterministic apply-gate for a Simplified restyle.

Compare a proposed rewrite against the original note. Reference spans
([[wikilinks]], ![[embeds]], inline code) and fixed structure (headings,
code fences, thematic breaks) must survive. A nonzero exit blocks a silent
apply.

Usage:
  simplify-verify <original.md> [rewrite.md]

  <original.md> is the reference note on disk. The proposed rewrite is read
  from [rewrite.md], or from stdin when it is omitted or '-'. So the
  simplify-text skill pipes the extracted ## rewrite block in and gates the
  write on the exit code.

Options:
  -h, --help   show this help and exit

Output:
  A short report to stdout — spans, headings, fences, thematic breaks, each
  OK or DRIFT. The original is never modified; this tool applies nothing.
  Exit: 0 verified · 1 drift (block the apply) · 2 usage error · 3 empty input.
`;

// The validated options parseArgs hands to main: the original note path (always a file) and the
// rewrite source (undefined or "-" means stdin).
type VerifyOpts = { original: string; rewrite?: string };

// The result of parsing argv: "help" (print USAGE, exit 0), "error" (usage mistake, exit 2), or
// "ok" (validated options).
export type ParseResult =
  | { kind: "help" }
  | { kind: "error"; message: string }
  | { kind: "ok"; opts: VerifyOpts };

// Whole CLI surface as one pure argv→result function (the simplify.ts discipline): help and misuse
// resolve before any I/O, and the surface is unit-testable without spawning the binary. `--` ends
// options; a bare `-` is a positional (stdin for the rewrite); any other dash-prefixed token is a
// flag typo, named rather than misattributed. The original must be a real path — stdin already
// carries the rewrite, so an original from stdin would be ambiguous.
export function parseArgs(argv: string[]): ParseResult {
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") return { kind: "help" };
    if (a === "--") {
      for (let j = i + 1; j < argv.length; j++) positionals.push(argv[j]);
      break;
    }
    if (a.startsWith("-") && a !== "-") return { kind: "error", message: `unknown flag '${a}'` };
    positionals.push(a);
  }
  const [original, rewrite, ...rest] = positionals;
  if (original === undefined)
    return { kind: "error", message: "missing <original.md> — the note to verify against" };
  if (original === "-")
    return {
      kind: "error",
      message: "<original.md> must be a file path, not stdin (stdin carries the rewrite)",
    };
  if (rest.length)
    return { kind: "error", message: `unexpected extra argument(s): ${rest.join(", ")}` };
  return { kind: "ok", opts: { original, rewrite } };
}

// main is the CLI entrypoint: parse argv, act on --help and misuse, read the original file and the
// rewrite (file or stdin), run the pure verify, print the report, and set the exit code (0 verified,
// 1 drift, 2 usage, 3 empty input). It returns no value.
function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.kind === "help") {
    process.stdout.write(USAGE);
    return;
  }
  if (parsed.kind === "error") {
    console.error(`simplify-verify: ${parsed.message}\nTry 'simplify-verify --help' for usage.`);
    process.exit(2);
    return; // process.exit ends the run; the explicit return narrows `parsed` to "ok" below
  }
  const { original, rewrite } = parsed.opts;
  const originalText = readFileSync(original, "utf8");
  const fromStdin = rewrite === undefined || rewrite === "-";
  if (fromStdin && process.stdin.isTTY)
    console.error("simplify-verify: reading the rewrite from stdin (ctrl-d ends input)");
  const rewriteText = readFileSync(fromStdin ? 0 : rewrite, "utf8");
  if (!originalText.trim() || !rewriteText.trim()) {
    console.error("simplify-verify: empty input — need both the original note and the rewrite");
    process.exit(3);
  }
  const report = verify(originalText, rewriteText);
  process.stdout.write(`${formatVerify(report)}\n`);
  if (!verifyClean(report)) process.exit(1);
}

// Guard the entrypoint so test imports load this module (verify, parseArgs, USAGE) without running
// the gate against stdin.
if (import.meta.main) main();
