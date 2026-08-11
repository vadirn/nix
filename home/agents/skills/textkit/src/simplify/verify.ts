#!/usr/bin/env bun
// simplify-verify — the deterministic apply-gate for a Simplified restyle. See the USAGE block
// below for the CLI surface (invocation, output contract, exit codes).
//
// This is the verify half of `apply-mask-verify`. The simplify-text CLI (simplify.ts) covers the
// model-and-unmask stretch with its advisory `## Guard`. This tool covers the stretch after: the
// subagent extracts the `## Rewrite` block from the brief and is about to write it over the user's
// real note. That one edit is unverified, and its likely failure — a nested ``` fence truncating a
// naive extractor mid-block — drops content that trips no name typo. So the gate compares the
// extracted rewrite against the original on two deterministic axes and, unlike the CLI guard, exits
// NONZERO on drift: the apply mutates a real file, so a shipped corruption is permanent.
//
//   spans      — the verbatim-span multiset ([[wikilinks]], ![[embeds]], inline code,
//                `<!-- HTML comments -->`, via the shared VERBATIM_SPAN_RE the masker also
//                freezes) is identical. A dropped, mutated, or invented span is drift. A comment
//                sits here because a REWORDED one is the failure — the restyle turned a
//                template's `repo-self-sufficient` into `self-sufficient` and every count in the
//                note stayed equal — so only content equality catches it.
//   structure  — the heading count, the code-block count, AND the thematic-break (`---`) count
//                match. mdstruct parses each side once and all three counts are read off that one
//                tree, so a setext heading counts as a heading, a fence inside a blockquote counts
//                as a code block, and a `#` line in frontmatter counts as neither. A truncation
//                that drops no span still drops a heading, a code block, or a `---` separator a
//                template requires, so this is the backstop for a pure-prose note the span axis
//                cannot check.
//
// No model, no key, no network — the spans and the parsed structure are the certificate, and
// checking them is format validation. The parse itself shells out to the `mdstruct` binary, which
// this gate depends on hard: a missing binary exits 5 and prints no report, because a gate that
// reports "verified" off a weaker check is worse than no gate. (Not core/writing/verify.ts, which
// is verifySpellBlock, the CLI-side block verifier for a change-nothing-else pass. This gate is
// skill-side and fires on a heavy restyle's applied output.)
import { readFileSync } from "node:fs";
import {
  MdstructUnavailableError,
  parseDoc,
  walkHeadings,
  walkNodes,
} from "textkit/core/mdstruct.ts";
import { VERBATIM_SPAN_RE } from "textkit/core/text.ts";

// ---- the two axes (deterministic; the structural one reads a parse) ----

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

// One structural-count axis (headings, code blocks, or thematic breaks): the count on each side and
// whether they match. Internal — VerifyReport reuses it for all three count axes.
type CountAxis = { ok: boolean; original: number; rewrite: number };

// The full verify outcome — the span axis plus the three structural-count axes. verifyClean reads
// it to the single gate bit; formatVerify renders it to the report.
export type VerifyReport = {
  spans: SpanDiff;
  headings: CountAxis;
  fences: CountAxis;
  thematic: CountAxis;
};

// The verbatim spans VERBATIM_SPAN_RE finds in a text, in document order. `.match` with the shared
// global regex resets its lastIndex and returns every match (mask.ts relies on the same idiom), so
// reusing the constant createMasker freezes is safe and keeps the gate's span definition identical
// to what it masks — the invariant that lets the gate catch a span the masker meant to protect.
const spanList = (text: string): string[] => text.match(VERBATIM_SPAN_RE) ?? [];

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

// Count every heading mdstruct parsed, ATX and setext alike, walking the nested `headings[]` tree.
// The parser settles three cases the old line scan got wrong: a setext underline makes a heading, a
// `#` inside a fenced block does not, and a `#` line inside YAML frontmatter does not either. That
// last one is why the count is now an ABSOLUTE reading rather than one whose false positives had to
// cancel across the two sides — the CLI reads a whole file as the original and takes a rewrite piped
// without frontmatter, so nothing guarantees the two sides carry the same frontmatter to cancel.
function headingCount(text: string): number {
  let n = 0;
  walkHeadings(parseDoc(text).doc.headings, () => n++);
  return n;
}

// Count the block nodes of one `type` in a parsed side. walkNodes descends into every child, so a
// node nested in a blockquote or a list item counts the same as one at the top level.
function nodeCount(text: string, type: string): number {
  let n = 0;
  walkNodes(parseDoc(text).doc.nodes, (node) => {
    if (node.type === type) n++;
  });
  return n;
}

// The fence axis counts CODE BLOCKS, not marker lines: one `codeBlock` node per block, fenced or
// indented, including a fence inside a blockquote the old line scan read as prose. So a truncation
// that eats a whole block reads as a 1 → 0 delta rather than the old odd marker delta. A truncation
// that eats only a closer no longer shows here at all — an unclosed fence still parses as one block
// — but it swallows the tail into that block, which the heading and span axes then report.
function codeBlockCount(text: string): number {
  return nodeCount(text, "codeBlock");
}

// Count `thematicBreak` nodes — the parser's own reading of `---`, `***`, and `___`. It excludes
// what the old regex had to strip by hand (frontmatter delimiters, a `---` inside a fenced block)
// and, load-bearing here, it excludes a setext underline: that `---` is a heading's second line, so
// the parser gives it to the heading axis and never to this one. A dropped `---` separator (the
// gh-stack footer rule a template needs) is the drift this axis catches.
function thematicBreakCount(text: string): number {
  return nodeCount(text, "thematicBreak");
}

// verify compares the proposed `rewrite` against the `original` note on every axis and returns the
// combined report. Deterministic but not pure: the three structural axes read one mdstruct parse per
// side (the cache keys on source text, so each side spawns once). It throws
// MdstructUnavailableError when that parse cannot run, and main maps that to exit 5.
export function verify(original: string, rewrite: string): VerifyReport {
  const so = spanList(original);
  const sr = spanList(rewrite);
  const { dropped, invented } = multisetDiff(so, sr);
  const ho = headingCount(original);
  const hr = headingCount(rewrite);
  const fo = codeBlockCount(original);
  const fr = codeBlockCount(rewrite);
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
      ? `- fences: OK — ${r.fences.original} code block(s) preserved`
      : `- fences: DRIFT — ${r.fences.original} code block(s) in source, ${r.fences.rewrite} in rewrite`,
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

Compare a proposed rewrite against the original note. Verbatim spans
([[wikilinks]], ![[embeds]], inline code, <!-- HTML comments -->) and fixed
structure (headings, code fences, thematic breaks) must survive. A nonzero
exit blocks a silent apply.

Usage:
  simplify-verify <original.md> [rewrite.md]

  <original.md> is the reference note on disk. The proposed rewrite is read
  from [rewrite.md], or from stdin when it is omitted or '-'. So the
  simplify-text skill pipes the extracted ## Rewrite block in and gates the
  write on the exit code.

Options:
  -h, --help   show this help and exit

Output:
  A short report to stdout — spans, headings, fences, thematic breaks, each
  OK or DRIFT. The original is never modified; this tool applies nothing.
  Exit: 0 verified · 1 drift (block the apply) · 2 usage error · 3 empty input ·
  5 the gate could not run (see below).

Structure comes from the mdstruct binary, which must be on PATH. A missing
or stale binary exits 5 and prints no report: 1 says the rewrite drifted,
5 says the gate never ran. Both block the apply — name which one happened.
Rebuild with ./rebuild.sh in the nix repo. There is no regex fallback: a
gate that reports "verified" off a weaker check is worse than no gate.
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
// rewrite (file or stdin), run verify, print the report, and set the exit code (0 verified, 1 drift,
// 2 usage, 3 empty input, 5 the gate could not run). It returns no value.
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
  // Exit 5 is its own lane, ahead of the report: the structure axes could not be computed, so there
  // is no report to print and no verdict to claim. It stays distinct from 1 so the caller can say
  // whether the rewrite drifted or the gate never ran.
  let report: VerifyReport;
  try {
    report = verify(originalText, rewriteText);
  } catch (e) {
    if (e instanceof MdstructUnavailableError) {
      console.error(
        `simplify-verify: the gate could not run — ${e.message}\n` +
          "Rebuild mdstruct (./rebuild.sh in the nix repo), then re-run. Block the apply meanwhile.",
      );
      process.exit(5);
    }
    throw e;
  }
  process.stdout.write(`${formatVerify(report)}\n`);
  if (!verifyClean(report)) process.exit(1);
}

// Guard the entrypoint so test imports load this module (verify, parseArgs, USAGE) without running
// the gate against stdin.
if (import.meta.main) main();
