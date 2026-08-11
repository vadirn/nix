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
//   code     — code blocks (not masked, unlike inline spans) are intact as a multiset. It reads
//              mdstruct's `codeBlock` nodes, so a fence inside a blockquote is a block here — the
//              latching line scan read that one as prose and passed a mangled quoted block.
//   names    — nameLintAgainstSource: no proper name corrupted toward a source name or invented.
//   sentences — wordCapScan: no prose sentence over the 20-word cap. It reads mdstruct's parse of
//              the rewrite, so a blockquote's frozen specimen is never reported as an offender the
//              restyle failed to close.
//   lists    — three readings of one question: did the rewrite build list structure the source never
//              licensed? All three read mdstruct's `list` and `listItem` nodes, so a nested sublist
//              opens its own block and a `- - -` is a thematic break splitting a run, not a
//              one-item list — both fall out of the parse with no exclusion to write.
//              (a) FLIP: a list KIND the source had (numbered or bulleted) still exists —
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
//              (c) is English-only because the scan finds 1268 sequences across 909 English vault
//              files and 1 across 263 Russian ones — `bun run measure:oxford`, fed the vault's
//              markdown on stdin, reports that split under `byLang`. With no budget to speak of it
//              would fire on any Russian note that gains a list, which is noise, not a finding.
//              The contract the model
//              receives stays identical in both languages; only this measurement's reach differs,
//              exactly as the scan's own reach does.
import { parseDoc, sliceBytes, walkNodes } from "textkit/core/mdstruct.ts";
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

// codeBlocks extracts every code block from `text` as its exact bytes, opener through closer, by
// slicing each `codeBlock` node's span. The parser reads a block wherever it sits, which the
// latching line scan could not: a fence inside a blockquote never showed the scanner an unprefixed
// marker, so a quoted block reached this axis as prose and a reworded one passed. An indented block
// is a `codeBlock` too and now counts, which only widens what must survive. An unclosed fence still
// parses as one block, swallowing its tail. Compared as a multiset between input and rewrite: masked
// forms on both sides, so a preserved block is byte-identical.
function codeBlocks(text: string): string[] {
  const { doc, buf } = parseDoc(text);
  const blocks: string[] = [];
  walkNodes(doc.nodes, (n) => {
    if (n.type === "codeBlock" && n.span) blocks.push(sliceBytes(buf, n.span));
  });
  return blocks;
}

// multisetEqual reports whether two string arrays hold the same elements with the same
// multiplicities (order-independent) — the code-block intactness test.
function multisetEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((x, i) => x === sb[i]);
}

const sum = (ns: number[]): number => ns.reduce((a, b) => a + b, 0);

// One list BLOCK on one side: its kind and how many items it holds. mdstruct emits a `list` node per
// block and a `listItem` child per item, so both numbers the three readings need come off one walk.
// Internal — the readings consume the derived counts below, never this shape.
type ListBlock = { ordered: boolean; items: number };

// listBlocks reads every list in `text`, in document order. Four things the two line patterns had to
// guess at now fall out of the parse. A nested sublist is its own `list` node inside its parent's
// item, so it opens its own block instead of merging into the parent's run — the undercount the old
// listBlockSizes admitted in its own comment. A `- - -` is a `thematicBreak` that splits the run in
// two, because CommonMark gives a break precedence over a list item, so the old explicit exclusion
// has nothing left to exclude. A run broken by a blank line is ONE loose list, where the line scan
// closed the run and counted two blocks. And a `- x` line inside a fence belongs to a `codeBlock`,
// which is what retired the stripFences pre-pass.
//
// The walk descends into a blockquote too. A quoted specimen is frozen by KEEP, so its lists stand
// unchanged on both sides and cancel out of all three readings; when they stop cancelling, the
// specimen was mangled, which is a finding worth reporting.
//
// Read on masked forms like the code and word-cap axes: masking freezes reference spans to ⟦N⟧ and
// never touches a list marker. Frontmatter never reaches here either — the CLI splits it off before
// masking, so a `tags:` entry is never read as a one-item list.
function listBlocks(text: string): ListBlock[] {
  const blocks: ListBlock[] = [];
  walkNodes(parseDoc(text).doc.nodes, (n) => {
    if (n.type !== "list") return;
    blocks.push({
      ordered: n.ordered === true,
      items: (n.children ?? []).filter((c) => c.type === "listItem").length,
    });
  });
  return blocks;
}

// listMarkers totals items by kind across one side's blocks: ordered (`1.`) and unordered
// (`-`/`*`/`+`). The list axis compares these two counts across source and rewrite to detect a
// vanished kind. A multi-line item counts once now, because the parser owns the item boundary and
// the old pattern counted marker LINES.
const listMarkers = (blocks: ListBlock[]): ListCounts => ({
  ordered: sum(blocks.filter((b) => b.ordered).map((b) => b.items)),
  unordered: sum(blocks.filter((b) => !b.ordered).map((b) => b.items)),
});

// listBlockSizes returns one item count per list block — the boundaries readings (b) and (c) need,
// which listMarkers deliberately discards.
const listBlockSizes = (blocks: ListBlock[]): number[] => blocks.map((b) => b.items);

// unconfirmedStructure measures reading (c): blocks and items the rewrite added beyond what the scan
// confirmed. The scan's findings are a FLOOR on what the source licenses, never a ceiling, so an
// overrun is a pointer to check and not a violation to remove — the caller's rendering must keep
// that distinction. Null on Russian: 263 Russian vault files yield 1 finding against 1268 from 909
// English ones, so the budget there is effectively zero and every added list would trip it. Re-derive
// the split with `bun run measure:oxford` over the vault; it prints one under `byLang`.
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
// pure but for the parse: the code, sentences, and lists axes all read mdstruct's tree, so it throws
// MdstructUnavailableError when the binary cannot run. parseDoc caches by exact source text, so
// those three axes over two sides cost two spawns. runSimplify parses the source before its first
// model call, so by the time this runs a missing binary has already exited 5.
export function runGuard(input: GuardInput): GuardReport {
  const { source, maskedInput, rewriteMasked, rewriteUnmasked, sequences, lang } = input;
  const srcBlocks = codeBlocks(maskedInput);
  const outBlocks = codeBlocks(rewriteMasked);
  const srcLists = listBlocks(maskedInput);
  const outLists = listBlocks(rewriteMasked);
  const srcList = listMarkers(srcLists);
  const outList = listMarkers(outLists);
  const srcSizes = listBlockSizes(srcLists);
  const outSizes = listBlockSizes(outLists);
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
      ? `- code: OK — ${r.code.source} code block(s) intact`
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
