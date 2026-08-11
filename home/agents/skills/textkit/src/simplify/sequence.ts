// simplify/sequence — the deterministic scan behind the SHAPE rule: find prose sentences that
// enumerate three or more members, which the style turns into a vertical list. Sibling of wordcap:
// same line-based scan over the MASKED source, same advisory framing, same feed into a prompt
// pre-hint. It exists for the reason capHint exists — the ruleset states SHAPE, and a live pass
// applied it to nothing. A source sentence coordinating four verbs came back as four sentences,
// tagged `split`, with `## Shape` reporting "None": the model reached for the rule that arrived as a
// measured worklist over the rule that arrived as a principle.
//
// Unlike wordcap, this scan SKIPS list items rather than stripping their markers. A sequence inside
// an existing list item must stay prose — KEEP forbids growing a list's item count, and nesting a
// new list under an item is the over-split this whole module guards against.
import { stripFences } from "textkit/core/text.ts";

// One prose sentence that enumerates: its text and how many delimited members it carries. `members`
// counts comma- or semicolon-delimited segments, whichever is larger. It is a measurement, not a
// parse — "verdicts it ⟦1⟧, ⟦2⟧, ⟦3⟧, or ⟦4⟧" reads as four members inside one clause, so the count
// runs high on a sentence whose final member is itself a series. The finding is what acts; the
// number only tells the reader how it was reached, and shapeHint tells the model to recount.
export type SequenceFinding = { sentence: string; members: number };

// The Simplified threshold: three or more members is a sequence. Two is a pair, and a pair reads
// better as prose than as a two-item list.
export const SEQ_MIN = 3;

// A line that is structure or already-shaped content, so the scan skips it whole: a heading, a table
// row, a blank line, a blockquote (a quoted specimen KEEP freezes), or a list item. The list-item
// skip is the load-bearing one — see the header note.
const isSkippedLine = (line: string): boolean =>
  /^\s*#{1,6}\s/.test(line) || // heading
  /\|/.test(line) || // table row (or any cell-delimited line)
  /^\s*>/.test(line) || // blockquote — a quoted specimen
  /^\s*(?:[-*+]\s|\d{1,9}[.)]\s)/.test(line) || // list item: a nested list is the over-split
  line.trim() === "";

// Sentence boundary: end punctuation, then any CLOSING inline markers, then whitespace. Identical to
// wordcap's — the Simplified style writes bold leads, so a sentence routinely ends at `.**` rather
// than `.`, and a bare `[.!?…]` lookbehind merges the lead into the sentence after it.
const SENTENCE_SPLIT_RE = /(?<=[.!?…][*_`)\]"'»”’]*)\s+(?=\S)/;

// A relative-clause aside sits between two commas and delimits nothing. Splitting on its commas
// counts the aside AND cuts its host clause in two, so "The scan, which is deterministic, measures
// the source" reads as three segments where there is one member. The aside is therefore removed from
// the sentence BEFORE the split, not dropped from the segments after it — dropping leaves the host's
// two halves counted separately, which is the same over-count one step later.
const ASIDE_RE = /,\s+(?:which|who|whom|whose|that|where|when)\b[^,]*,/g;

// The coordinator that closes a series, read off the segment that OPENS with it: in "A, B, and C"
// that is " and C", so the members run from the first segment through this one. Requiring it is what
// keeps a bare comma run out, because an appositive, a date, or a run of asides never has one.
//
// Every count below comes from one corpus, so a later reader can re-run it: `bun run
// measure:oxford`, which scans the markdown `git ls-files '*.md'` returns at the repo root — 383
// files when this was measured, on 2026-08-11 — each read the way runSimplify reads it, body only
// and masked. Keep a number here reproducible by that script. The figures these replaced gave a
// file count and no selector, so nobody could recheck them, and their arithmetic drifted unnoticed.
//
// The series need not END the sentence, and that is why the coordinator is located rather than
// checked on the last segment alone. Real prose continues past the final member — "Out of scope: A,
// B, and C, which is its own decision node" — and demanding the coordinator close the sentence
// drops 70 genuine series. Segments after the coordinator are trailing material, so they are
// counted out rather than counted as members.
//
// The Oxford comma is REQUIRED, and that is a deliberate precision choice rather than an oversight.
// Accepting "A, B and C" means counting a final segment that merely CONTAINS a coordinator, and
// "member, member and member" is regex-indistinguishable from "adverbial, clause and clause" — so
// "In this mode, the scan strips fences and skips lists" scores 3. Accepting the form takes findings
// from 562 to 971. Every one of those 409 is a new candidate, because the strict scan's findings all
// survive it, and two samples totalling 49 of them turned up no genuine series — nearly all open
// with a subordinate clause or an adverbial. That cost lands hardest here: shapeHint hands the model
// a CLOSED worklist, so a false candidate is not noise the model may ignore, it is a licensed
// conversion — the manufacturing this module exists to stop. A missed series only stays prose.
//
// The cost is unequal by language, and Russian pays it. Russian punctuation writes «А, Б и В» with
// no comma before "и", so every Russian comma series is non-Oxford and none can be scanned. Russian
// keeps the semicolon path only. Closing that gap needs a language-aware scan, not a wider regex.
const COORD_OPENS_RE = /^\s*(?:and|or)\s/;

// Count delimited segments in one sentence. Empty/whitespace-only counts as 0 members.
const segmentsOn = (s: string, delim: string): number => (s.trim() ? s.split(delim).length : 0);

// commaMembers counts the members of a comma-delimited series, or 0 when the sentence closes with no
// coordinator — a bare comma run is an aside or an appositive, never a series. Asides come out
// first, so a series carrying a relative clause ("The tools we ship, which run offline, are A, B,
// and C") still counts its three real members.
function commaMembers(sentence: string): number {
  if (!sentence.trim()) return 0;
  const segments = sentence.replace(ASIDE_RE, "").split(",");
  const closer = segments.findIndex((s, i) => i > 0 && COORD_OPENS_RE.test(s));
  return closer < 0 ? 0 : closer + 1;
}

// sequenceScan returns every prose sentence in `masked` that enumerates `min` or more members, most
// members first. It strips fenced code, skips structure and list items, splits each remaining line
// into sentences, and measures both delimiters. Total: never throws.
//
// A sentence qualifies when either form is present:
//   - `min` or more semicolon-delimited segments — a set, whatever its wording; or
//   - `min` or more comma-delimited members closing on ", and"/", or" — a series, Oxford comma required.
export function sequenceScan(masked: string, min: number = SEQ_MIN): SequenceFinding[] {
  const findings: SequenceFinding[] = [];
  for (const raw of stripFences(masked).split("\n")) {
    if (isSkippedLine(raw)) continue;
    for (const sentence of raw.split(SENTENCE_SPLIT_RE)) {
      const semis = segmentsOn(sentence, ";");
      const commas = commaMembers(sentence);
      const isSet = semis >= min;
      const isSeries = commas >= min;
      if (isSet || isSeries)
        findings.push({ sentence: sentence.trim(), members: Math.max(semis, commas) });
    }
  }
  return findings.sort((a, b) => b.members - a.members);
}
