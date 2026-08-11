// simplify/wordcap — the one new deterministic pass the restyle needs: find prose sentences over
// the Simplified 20-word cap. No other textkit pass counts words per sentence (the only word logic
// elsewhere is a body-word total for a footer), so this is Simplified-specific. Advisory: the
// guard reports the count and the offenders; the CLI never fails on them.
//
// Scans the MASKED rewrite (a frozen ⟦N⟧ reference span counts as one referent, not its inner
// words), reading only what mdstruct parsed as a paragraph — so fenced code, headings, and table
// cells never reach the count.
//
// The prose comes from proseParagraphs, and everything measured below is prose measurement that
// stays here. The parser only decides which bytes are prose.
import { proseParagraphs } from "textkit/simplify/prose.ts";

// One over-cap prose sentence: its text and its word count. `words` always exceeds the cap.
export type WordCapFinding = { sentence: string; words: number };

// The Simplified cap: one idea per sentence, at most this many words.
export const WORD_CAP = 20;

// The container blocks whose contents this scan never reads, as mdstruct node types. Only one
// entry, and it is where this scan and sequence's policy diverge: a list is NOT skipped here,
// because a list item's prose is prose the restyle may shorten, while sequence must never reach
// into one. The parser hands that prose over already stripped — a list item's paragraph starts
// after the marker and after the GFM task box, which is what retired the old marker strip.
//
// A blockquote is skipped because KEEP freezes a quoted specimen, so an over-cap sentence inside
// one is a finding no rewrite is allowed to close. capHint hands the model each finding as "split
// this", and the guard re-reports whatever is left, so a quoted long sentence used to ride as a
// permanent finding that pointed at text the ruleset forbids touching. The old line scan measured
// it because stripLeadingMarker treated `>` as one more marker to peel off.
const FROZEN_BLOCKS = new Set(["blockQuote"]);

// A sentence boundary: end punctuation, then any CLOSING inline markers, then whitespace. The
// closers are load-bearing: the Simplified style writes bold leads, so a sentence routinely ends at
// `.**` rather than `.` — "**Advisory, and it degrades to a skip.** The finding rides…". A bare
// `[.!?…]` lookbehind found no boundary there and merged the lead with the sentence after it,
// reporting one phantom 23-word sentence where two 7- and 16-word sentences sit, both under the cap.
// That false positive is noise in the advisory guard, but the prompt's length pre-hint ACTS on these
// findings, so a phantom offender would push the model to split prose that is already compliant.
const SENTENCE_SPLIT_RE = /(?<=[.!?…][*_`)\]"'»”’]*)\s+(?=\S)/;

// Count whitespace-separated words in one sentence; empty/whitespace-only counts as 0.
const wordsIn = (s: string): number => {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
};

// wordCapScan returns every prose sentence in `masked` whose word count exceeds `cap`, longest
// first. It reads mdstruct's paragraphs, skipping every blockquote, splits each into sentences on
// end punctuation, and counts words.
//
// Not total: the parse throws MdstructUnavailableError when the binary cannot run. simplify-text
// parses the source before its first model call and maps that class to exit 5, so the failure lands
// before any token is spent.
export function wordCapScan(masked: string, cap: number = WORD_CAP): WordCapFinding[] {
  const findings: WordCapFinding[] = [];
  for (const paragraph of proseParagraphs(masked, FROZEN_BLOCKS)) {
    // split on sentence-ending punctuation (plus any closing markers) followed by whitespace; the
    // trailing run (no closing punctuation) is still one sentence.
    for (const sentence of paragraph.split(SENTENCE_SPLIT_RE)) {
      const words = wordsIn(sentence);
      if (words > cap) findings.push({ sentence: sentence.trim(), words });
    }
  }
  return findings.sort((a, b) => b.words - a.words);
}
