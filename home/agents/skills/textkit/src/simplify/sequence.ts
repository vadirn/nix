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
// number only tells the reader how it was reached.
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

// A serial coordination closing a comma-delimited run: "A, B, and C" or "A, B, or C". Required for
// the comma form, because a comma count alone also matches an aside or an appositive. A semicolon
// run needs no such marker — semicolons at this density only ever delimit members.
const SERIAL_RE = /,\s+(?:and|or)\s/;

// Count delimited segments in one sentence. Empty/whitespace-only counts as 0 members.
const segmentsOn = (s: string, delim: string): number => (s.trim() ? s.split(delim).length : 0);

// sequenceScan returns every prose sentence in `masked` that enumerates `min` or more members, most
// members first. It strips fenced code, skips structure and list items, splits each remaining line
// into sentences, and measures both delimiters. Total: never throws.
//
// A sentence qualifies when either form is present:
//   - `min` or more semicolon-delimited segments — a set, whatever its wording; or
//   - `min` or more comma-delimited segments AND a closing "and"/"or" — a series.
export function sequenceScan(masked: string, min: number = SEQ_MIN): SequenceFinding[] {
  const findings: SequenceFinding[] = [];
  for (const raw of stripFences(masked).split("\n")) {
    if (isSkippedLine(raw)) continue;
    for (const sentence of raw.split(SENTENCE_SPLIT_RE)) {
      const semis = segmentsOn(sentence, ";");
      const commas = segmentsOn(sentence, ",");
      const isSet = semis >= min;
      const isSeries = commas >= min && SERIAL_RE.test(sentence);
      if (isSet || isSeries)
        findings.push({ sentence: sentence.trim(), members: Math.max(semis, commas) });
    }
  }
  return findings.sort((a, b) => b.members - a.members);
}
