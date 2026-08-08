// simplify/guard — the deterministic verification layer. The single model pass is unverified until
// this runs; it replaces the model judge the feasibility spike killed, and it catches the errors a
// peer model does not — a dropped code span, a mangled reference, a corrupted name, a still-too-long
// sentence. Every finding is ADVISORY: the guard reports each in the brief's `## Guard` section and
// never changes the exit code (an operational failure — bad args, a dead model call — is the CLI's
// concern, not the guard's). The subagent and the human decide what to do with a reported violation.
//
// Five axes, three reusing shared core/writing engines, two new:
//   masks    — masksSurvived: every ⟦N⟧ reference span survived the rewrite (a heavy restyle
//              changes line count and diff size by design, so ONLY mask-survival transfers from the
//              spell verifier).
//   code     — fenced code blocks (not masked, unlike inline spans) are intact as a multiset.
//   names    — nameLintAgainstSource: no proper name corrupted toward a source name or invented.
//   sentences — wordCapScan: no prose sentence over the 20-word cap.
//   lists    — a list KIND the source had (numbered or bulleted) still exists in the rewrite. This
//              is advisory, not a hard gate: exact item count cannot be an invariant because the
//              SHAPE rule inflates a list on purpose (a prose set becomes a vertical list), so only
//              a vanished kind — the observed numbered→bulleted over-split — trips the axis.
import { THEMATIC_BREAK_RE, type FenceState, fenceScan, stripFences } from "textkit/core/text.ts";
import { MASK_TOKEN_RE, masksSurvived } from "textkit/core/writing/mask.ts";
import { type NameLintResult, nameLintAgainstSource } from "textkit/core/writing/name-lint.ts";
import { type WordCapFinding, WORD_CAP, wordCapScan } from "textkit/simplify/wordcap.ts";

// GuardReport is the outcome of one guard run — one field per axis. `masks` and `code` carry the
// pass/fail plus the before/after counts the brief prints; `names` and `wordcap` are the raw
// engine results the brief summarizes.
export type GuardReport = {
  masks: { ok: boolean; input: number; output: number };
  code: { ok: boolean; source: number; rewrite: number };
  names: NameLintResult;
  wordcap: WordCapFinding[];
  list: { ok: boolean; source: ListCounts; rewrite: ListCounts };
};

// The list-item marker counts on one side: ordered (`1.`) and unordered (`-`/`*`/`+`) items. The
// list axis compares these two counts across source and rewrite to detect a vanished kind. Internal
// — GuardReport reuses it for both sides; consumers build the shape with object literals.
type ListCounts = { ordered: number; unordered: number };

// The four strings the guard reads: the raw source body (name-lint reference, unmasked prose), the
// masked input and masked rewrite (mask-survival, code, and word-cap all read masked forms so a
// frozen span is one referent), and the unmasked rewrite (name-lint target — names live in prose,
// which masking never touches).
export type GuardInput = {
  source: string;
  maskedInput: string;
  rewriteMasked: string;
  rewriteUnmasked: string;
};

const countTokens = (s: string): number => (s.match(MASK_TOKEN_RE) ?? []).length;

// fencedBlocks extracts every fenced code block (opener through closer, inclusive) from `text`,
// using the shared latching fence scanner so an opposite-marker run inside a fence is literal
// content, not a close. An unclosed fence yields its tail as one block. Compared as a multiset
// between input and rewrite: masked forms on both sides, so a preserved block is byte-identical.
function fencedBlocks(text: string): string[] {
  const blocks: string[] = [];
  let cur: string[] | null = null;
  let fence: FenceState = null;
  for (const line of text.split("\n")) {
    const inFence = fence !== null;
    const scan = fenceScan(line, fence);
    fence = scan.fence;
    if (scan.isMarker && !inFence) {
      cur = [line]; // opener
    } else if (scan.isMarker && inFence) {
      cur?.push(line);
      if (cur) blocks.push(cur.join("\n")); // closer
      cur = null;
    } else if (cur) {
      cur.push(line);
    }
  }
  if (cur) blocks.push(cur.join("\n"));
  return blocks;
}

// multisetEqual reports whether two string arrays hold the same elements with the same
// multiplicities (order-independent) — the fenced-block intactness test.
function multisetEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((x, i) => x === sb[i]);
}

const ORDERED_ITEM_RE = /^\s*\d{1,9}[.)]\s/;
const UNORDERED_ITEM_RE = /^\s*[-*+]\s/;

// listMarkers counts list-item lines by kind, outside fenced code. A `- - -` (or `* * *`) thematic
// break also matches the unordered pattern, so THEMATIC_BREAK_RE excludes it first — a horizontal
// rule is not a one-item list. Ordered wins ties (a line is one kind), though the two patterns are
// disjoint in practice. Read on masked forms like the code and word-cap axes: masking freezes
// reference spans to ⟦N⟧ and never touches a line's leading list marker.
function listMarkers(text: string): ListCounts {
  let ordered = 0;
  let unordered = 0;
  for (const line of stripFences(text).split("\n")) {
    if (THEMATIC_BREAK_RE.test(line)) continue;
    if (ORDERED_ITEM_RE.test(line)) ordered++;
    else if (UNORDERED_ITEM_RE.test(line)) unordered++;
  }
  return { ordered, unordered };
}

// listKindFlipped reports whether a list KIND present in the source vanished from the rewrite: the
// source had numbered items and the rewrite has none, or it had bulleted items and the rewrite has
// none. That is the observed over-split (3 numbered items promoted to 16 bullets → ordered 3→0).
// It does NOT flag a count change alone: a SHAPE transform legitimately inflates a list, so growth
// is not drift, only a disappeared kind is.
function listKindFlipped(source: ListCounts, rewrite: ListCounts): boolean {
  return (
    (source.ordered > 0 && rewrite.ordered === 0) ||
    (source.unordered > 0 && rewrite.unordered === 0)
  );
}

// runGuard applies all five axes to one rewrite and returns the combined report. Pure and total —
// it reads strings and calls total engines, so it never throws and touches no process state.
export function runGuard(input: GuardInput): GuardReport {
  const { source, maskedInput, rewriteMasked, rewriteUnmasked } = input;
  const srcBlocks = fencedBlocks(maskedInput);
  const outBlocks = fencedBlocks(rewriteMasked);
  const srcList = listMarkers(maskedInput);
  const outList = listMarkers(rewriteMasked);
  return {
    masks: {
      ok: masksSurvived(maskedInput, rewriteMasked),
      input: countTokens(maskedInput),
      output: countTokens(rewriteMasked),
    },
    code: {
      ok: multisetEqual(srcBlocks, outBlocks),
      source: srcBlocks.length,
      rewrite: outBlocks.length,
    },
    names: nameLintAgainstSource(rewriteUnmasked, source),
    wordcap: wordCapScan(rewriteMasked),
    list: { ok: !listKindFlipped(srcList, outList), source: srcList, rewrite: outList },
  };
}

// guardClean reports whether every axis passed — masks and code intact, no name findings, no
// over-cap sentence. The brief prints one "all checks passed" line when true.
export function guardClean(r: GuardReport): boolean {
  return (
    r.masks.ok &&
    r.code.ok &&
    r.names.corrupted.length === 0 &&
    r.names.invented.length === 0 &&
    r.wordcap.length === 0 &&
    r.list.ok
  );
}

// formatGuard renders the GuardReport as the brief's `## Guard` body: one line per axis, each an
// advisory finding. Clean axes are named too, so the reader sees the check ran and passed.
export function formatGuard(r: GuardReport): string {
  const lines: string[] = [];
  lines.push(
    r.masks.ok
      ? `- masks: OK — ${r.masks.input} reference span(s) survived`
      : `- masks: FAIL — ${r.masks.input} in source, ${r.masks.output} in rewrite (a ⟦N⟧ span was dropped, duplicated, or invented)`,
  );
  lines.push(
    r.code.ok
      ? `- code: OK — ${r.code.source} fenced block(s) intact`
      : `- code: FAIL — ${r.code.source} block(s) in source, ${r.code.rewrite} in rewrite (a block was reworded, dropped, or added)`,
  );
  lines.push(formatNames(r.names));
  lines.push(formatWordcap(r.wordcap));
  lines.push(formatList(r.list));
  return lines.join("\n");
}

// Render the list axis: a vanished kind (the over-split signal) names which kind went and prints
// both count deltas, or an OK line naming the preserved counts (or that there were no lists).
function formatList(l: GuardReport["list"]): string {
  const counts = `ordered ${l.source.ordered}→${l.rewrite.ordered}, unordered ${l.source.unordered}→${l.rewrite.unordered}`;
  if (l.ok) {
    return l.source.ordered + l.source.unordered === 0
      ? "- lists: OK — no lists to preserve"
      : `- lists: OK — list kinds preserved (ordered ${l.source.ordered}, unordered ${l.source.unordered})`;
  }
  const gone: string[] = [];
  if (l.source.ordered > 0 && l.rewrite.ordered === 0)
    gone.push(`${l.source.ordered} numbered item(s) became bulleted or were dropped`);
  if (l.source.unordered > 0 && l.rewrite.unordered === 0)
    gone.push(`${l.source.unordered} bulleted item(s) became numbered or were dropped`);
  return `- lists: FLIP — ${gone.join("; ")} (${counts})`;
}

// Render the name-lint axis: corrupted names (found ← wanted) and invented names, or OK.
function formatNames(n: NameLintResult): string {
  if (n.corrupted.length === 0 && n.invented.length === 0)
    return "- names: OK — no name corrupted or invented";
  const parts: string[] = [];
  if (n.corrupted.length)
    parts.push(
      `${n.corrupted.length} probable corrupted (${n.corrupted.map((c) => `${c.found} ← ${c.wanted}`).join(", ")})`,
    );
  if (n.invented.length) {
    const shown = n.invented.slice(0, 5);
    parts.push(
      `${n.invented.length} invented (${shown.join(", ")}${n.invented.length > 5 ? ", …" : ""})`,
    );
  }
  return `- names: ${parts.join(", ")}`;
}

// Render the word-cap axis: how many prose sentences exceed the cap, with the longest offender.
function formatWordcap(w: WordCapFinding[]): string {
  if (w.length === 0) return `- sentences: OK — all within the ${WORD_CAP}-word cap`;
  const longest = w[0]!;
  return `- sentences: ${w.length} over the ${WORD_CAP}-word cap (longest ${longest.words} words: "${clip(longest.sentence)}")`;
}

// Clip a long sentence for the one-line finding.
const clip = (s: string): string => (s.length > 80 ? `${s.slice(0, 77)}…` : s);
