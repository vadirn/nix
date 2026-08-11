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
//   sentences — wordCapScan: no prose sentence over the 20-word cap. It reads mdstruct's parse of
//              the rewrite, so a blockquote's frozen specimen is never reported as an offender the
//              restyle failed to close.
//   lists    — three readings of one question: did the rewrite build list structure the source never
//              licensed? (a) FLIP: a list KIND the source had (numbered or bulleted) still exists —
//              the observed numbered→bulleted over-split. (b) SHORT: no NEW block falls under the
//              SEQ_MIN member floor. The ruleset builds a list only at three or more members, so a
//              new two-item block is a violation with no judgment call in it. (c) UNCONFIRMED,
//              English only: how many blocks and items the rewrite added beyond what sequenceScan
//              confirmed.
//              Exact item count still cannot be an invariant — the SHAPE rule inflates a list on
//              purpose — which is why (c) reports UNCONFIRMED and never "excessive". The scan reads
//              an Oxford series and a semicolon set and nothing else, so a legitimate conversion of
//              a series it cannot see lands here too, and the finding says so in its own line.
//              Measured over eleven source/rewrite pairs before shipping: (c) named every known
//              manufactured list (4 of 4) at two false alarms, (b) named one at none. Together they
//              caught two live defects in four ordinary vault notes — a cause-and-effect relation
//              flattened into three siblings, and two 2-item lists built from a prose pair.
//              (c) is English-only because the scan finds 1360 sequences across 913 English vault
//              files and 5 across 251 Russian ones. With no budget to speak of it would fire on any
//              Russian note that gains a list, which is noise, not a finding. The contract the model
//              receives stays identical in both languages; only this measurement's reach differs,
//              exactly as the scan's own reach does.
import { THEMATIC_BREAK_RE, type FenceState, fenceScan, stripFences } from "textkit/core/text.ts";
import { MASK_TOKEN_RE, masksSurvived } from "textkit/core/writing/mask.ts";
import { type NameLintResult, nameLintAgainstSource } from "textkit/core/writing/name-lint.ts";
import { type SequenceFinding, SEQ_MIN } from "textkit/simplify/sequence.ts";
import { type WordCapFinding, WORD_CAP, wordCapScan } from "textkit/simplify/wordcap.ts";

// GuardReport is the outcome of one guard run — one field per axis. `masks` and `code` carry the
// pass/fail plus the before/after counts the brief prints; `names` and `wordcap` are the raw
// engine results the brief summarizes.
export type GuardReport = {
  masks: { ok: boolean; input: number; output: number };
  code: { ok: boolean; source: number; rewrite: number };
  names: NameLintResult;
  wordcap: WordCapFinding[];
  list: {
    ok: boolean;
    source: ListCounts;
    rewrite: ListCounts;
    short: { source: number; rewrite: number };
    unconfirmed: UnconfirmedStructure | null;
  };
};

// The list-item marker counts on one side: ordered (`1.`) and unordered (`-`/`*`/`+`) items. The
// list axis compares these two counts across source and rewrite to detect a vanished kind. Internal
// — GuardReport reuses it for both sides; consumers build the shape with object literals.
type ListCounts = { ordered: number; unordered: number };

// Reading (c): list structure the rewrite added beyond what the scan could vouch for. `blocks` and
// `items` are the overruns — at or below zero the rewrite stayed inside what the scan confirmed, so
// a negative number is a clean measurement, not a deficit. `candidates` and `budget` carry the scan
// totals the finding quotes, so a reader sees what the overrun was measured against. The whole
// record is null on Russian, where the scan has no usable reach; null therefore means NOT MEASURED,
// which is a different statement from a zero overrun, and the rendered line keeps them apart.
type UnconfirmedStructure = {
  blocks: number;
  items: number;
  candidates: number;
  budget: number;
};

// What the guard reads. Four strings: the raw source body (name-lint reference, unmasked prose), the
// masked input and masked rewrite (mask-survival, code, and word-cap all read masked forms so a
// frozen span is one referent), and the unmasked rewrite (name-lint target — names live in prose,
// which masking never touches). Then the scan's findings and the resolved language, which only the
// list axis reads. Neither is optional: there is one production call site, and a defaulted `lang`
// would silently run the English-only reading over a Russian rewrite — the one mistake this axis is
// scoped to avoid.
//
// The rewrite arrives BEFORE the CLI prepends the source frontmatter for display, so both sides are
// bodies and a `tags:` entry is never read as a one-item list on the rewrite side alone.
export type GuardInput = {
  source: string;
  maskedInput: string;
  rewriteMasked: string;
  rewriteUnmasked: string;
  sequences: SequenceFinding[];
  lang: "en" | "ru";
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

// listBlockSizes returns one item count per list BLOCK, outside fenced code — a block being a run of
// consecutive item lines, closed by a blank line or any prose line. Readings (b) and (c) need block
// boundaries, which listMarkers deliberately discards. Frontmatter never reaches here: the CLI
// splits it off before masking, so a `tags:` entry is never read as a one-item list. A nested
// sublist merges into its parent's run rather than opening its own block, which undercounts blocks
// and so can only make reading (b) miss a violation, never invent one.
function listBlockSizes(text: string): number[] {
  const sizes: number[] = [];
  let run = 0;
  for (const line of stripFences(text).split("\n")) {
    const isItem =
      !THEMATIC_BREAK_RE.test(line) && (ORDERED_ITEM_RE.test(line) || UNORDERED_ITEM_RE.test(line));
    if (isItem) {
      run++;
    } else if (run) {
      sizes.push(run);
      run = 0;
    }
  }
  if (run) sizes.push(run);
  return sizes;
}

const sum = (ns: number[]): number => ns.reduce((a, b) => a + b, 0);

// unconfirmedStructure measures reading (c): blocks and items the rewrite added beyond what the scan
// confirmed. The scan's findings are a FLOOR on what the source licenses, never a ceiling, so an
// overrun is a pointer to check and not a violation to remove — the caller's rendering must keep
// that distinction. Null on Russian: 251 Russian vault files yield 5 findings against 1360 from 913
// English ones, so the budget there is effectively zero and every added list would trip it.
function unconfirmedStructure(
  srcSizes: number[],
  outSizes: number[],
  sequences: SequenceFinding[],
  lang: "en" | "ru",
): UnconfirmedStructure | null {
  if (lang !== "en") return null;
  const candidates = sequences.length;
  const budget = sum(sequences.map((f) => f.members));
  return {
    blocks: outSizes.length - srcSizes.length - candidates,
    items: sum(outSizes) - sum(srcSizes) - budget,
    candidates,
    budget,
  };
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

// runGuard applies all five axes to one rewrite and returns the combined report. Deterministic, and
// pure but for one spawn: the sentences axis reads mdstruct's parse of the rewrite, so it throws
// MdstructUnavailableError when the binary cannot run. runSimplify parses the source before its
// first model call, so by the time this runs a missing binary has already exited 5.
export function runGuard(input: GuardInput): GuardReport {
  const { source, maskedInput, rewriteMasked, rewriteUnmasked, sequences, lang } = input;
  const srcBlocks = fencedBlocks(maskedInput);
  const outBlocks = fencedBlocks(rewriteMasked);
  const srcList = listMarkers(maskedInput);
  const outList = listMarkers(rewriteMasked);
  const srcSizes = listBlockSizes(maskedInput);
  const outSizes = listBlockSizes(rewriteMasked);
  const short = {
    source: srcSizes.filter((n) => n < SEQ_MIN).length,
    rewrite: outSizes.filter((n) => n < SEQ_MIN).length,
  };
  const unconfirmed = unconfirmedStructure(srcSizes, outSizes, sequences, lang);
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
    list: {
      ok:
        !listKindFlipped(srcList, outList) &&
        short.rewrite <= short.source &&
        (unconfirmed === null || (unconfirmed.blocks <= 0 && unconfirmed.items <= 0)),
      source: srcList,
      rewrite: outList,
      short,
      unconfirmed,
    },
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
  lines.push(...formatList(r.list));
  return lines.join("\n");
}

// Render the list axis: one line per reading that fired, or a single OK line when none did. FLIP and
// SHORT state violations, because each is certain — a kind vanished, or a new block sits under the
// member floor. UNCONFIRMED must NOT read as a violation, and the wording is the whole mechanism
// keeping it from doing so: it reports structure the scan could not vouch for, which a legitimate
// conversion of a series the scan cannot see also produces. So the line names the scan's reach, asks
// the reader to check the extra lists, and never asks for a removal. A reader who takes it as a
// verdict re-imposes the closed worklist this tool deliberately dropped.
function formatList(l: GuardReport["list"]): string[] {
  const out: string[] = [];
  const counts = `ordered ${l.source.ordered}→${l.rewrite.ordered}, unordered ${l.source.unordered}→${l.rewrite.unordered}`;
  const gone: string[] = [];
  if (l.source.ordered > 0 && l.rewrite.ordered === 0)
    gone.push(`${l.source.ordered} numbered item(s) became bulleted or were dropped`);
  if (l.source.unordered > 0 && l.rewrite.unordered === 0)
    gone.push(`${l.source.unordered} bulleted item(s) became numbered or were dropped`);
  if (gone.length) out.push(`- lists: FLIP — ${gone.join("; ")} (${counts})`);
  if (l.short.rewrite > l.short.source)
    out.push(
      `- lists: SHORT — ${l.short.rewrite - l.short.source} new list block(s) under ${SEQ_MIN} items` +
        ` (${l.short.source}→${l.short.rewrite}). A list needs ${SEQ_MIN} or more parallel members, so a pair stays prose.`,
    );
  const u = l.unconfirmed;
  if (u && (u.blocks > 0 || u.items > 0)) {
    const over: string[] = [];
    if (u.blocks > 0)
      over.push(`${u.blocks} block(s) beyond the ${u.candidates} the scan confirmed`);
    if (u.items > 0) over.push(`${u.items} item(s) beyond the confirmed ${u.budget}-member total`);
    out.push(
      `- lists: UNCONFIRMED — ${over.join(", ")}. The scan reads an Oxford series and a semicolon set` +
        ` only, so a real series it cannot see lands here too. Check each extra list carries ${SEQ_MIN}` +
        ` or more parallel members from one source sentence; keep it if it does.`,
    );
  }
  if (out.length) return out;
  if (l.source.ordered + l.source.unordered === 0 && l.rewrite.ordered + l.rewrite.unordered === 0)
    return ["- lists: OK — no lists to preserve"];
  const scope = l.unconfirmed === null ? ", structure unmeasured (RU)" : "";
  return [
    `- lists: OK — list kinds preserved (ordered ${l.source.ordered}, unordered ${l.source.unordered})${scope}`,
  ];
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
