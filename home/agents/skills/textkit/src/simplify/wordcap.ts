// simplify/wordcap — the one new deterministic pass the restyle needs: find prose sentences over
// the Simplified 20-word cap. No other textkit pass counts words per sentence (the only word logic
// elsewhere is a body-word total for a footer), so this is Simplified-specific. Advisory: the
// guard reports the count and the offenders; the CLI never fails on them.
//
// Scans the MASKED rewrite (a frozen ⟦N⟧ reference span counts as one referent, not its inner
// words), skipping structure that is not prose: fenced code, headings, and table rows. Notes in
// this corpus are unwrapped — one paragraph per line, per segment() — so a line-based scan does
// not split a sentence across a hard wrap.
import { stripFences } from "textkit/core/text.ts";

// One over-cap prose sentence: its text and its word count. `words` always exceeds the cap.
export type WordCapFinding = { sentence: string; words: number };

// The Simplified cap: one idea per sentence, at most this many words.
export const WORD_CAP = 20;

// A line that is structure, not prose: a heading, a table row, or a blank/marker-only line.
// Fenced code is already blanked by stripFences before this runs.
const isStructureLine = (line: string): boolean =>
  /^\s*#{1,6}\s/.test(line) || // heading
  /\|/.test(line) || // table row (or any cell-delimited line)
  line.trim() === "";

// Strip a leading list marker, blockquote marker, or numbered-list prefix so the prose after it is
// what gets counted — "- Run the thing." counts the sentence, not the bullet.
const stripLeadingMarker = (line: string): string =>
  line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s?)+/, "");

// Count whitespace-separated words in one sentence; empty/whitespace-only counts as 0.
const wordsIn = (s: string): number => {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
};

// wordCapScan returns every prose sentence in `masked` whose word count exceeds `cap`, longest
// first. It strips fenced code and structure lines, drops leading list/quote markers, splits each
// remaining line into sentences on end punctuation, and counts words. Total: never throws.
export function wordCapScan(masked: string, cap: number = WORD_CAP): WordCapFinding[] {
  const findings: WordCapFinding[] = [];
  for (const raw of stripFences(masked).split("\n")) {
    if (isStructureLine(raw)) continue;
    const prose = stripLeadingMarker(raw);
    // split on sentence-ending punctuation followed by whitespace; the trailing run (no closing
    // punctuation) is still one sentence.
    for (const sentence of prose.split(/(?<=[.!?…])\s+(?=\S)/)) {
      const words = wordsIn(sentence);
      if (words > cap) findings.push({ sentence: sentence.trim(), words });
    }
  }
  return findings.sort((a, b) => b.words - a.words);
}
