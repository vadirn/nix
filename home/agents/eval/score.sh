#!/usr/bin/env bash
# Scores every answer in a corpus mechanically. No judge: every metric is a
# regex or a word count, so the numbers are reproducible from the answers alone.
#
# Primary metric: contrast_per_1k — occurrences of the unasked-comparison
# constructions, per 1000 words. Word count and has_grade are guards: an arm
# could shrink its prose without changing what it includes, and a
# compression-only win would show up as a word-count collapse with a flat
# absolute count.
#
# Usage: bash score.sh <corpus>     # e.g. claude, glm — a dir under corpus/
# Writes results/<corpus>.tsv.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
. "$here/config.sh"
corpus="${1:-claude}"
outdir="$AGENTS_EVAL_DATA/corpus/$corpus"
[ -d "$outdir" ] || { echo "no such corpus: $outdir" >&2; exit 1; }
mkdir -p "$AGENTS_EVAL_DATA/results"
tsv="$AGENTS_EVAL_DATA/results/$corpus.tsv"

# The constructions under test, as one alternation.
CONTRAST=',[[:space:]]+not[[:space:]]+|;[[:space:]]+not[[:space:]]+|\brather than\b|\binstead of\b|\bnot just\b[^.]{0,80}\bbut\b|\bit'"'"'?s not\b[^.]{0,80}\bit'"'"'?s\b'
GRADE='\b(10|[0-9])/10\b|\bconfidence[: ]'

# rg exits 1 on no match; under pipefail that would abort the run, so swallow it.
count() { { rg -oi --no-filename --multiline "$2" "$1" 2>/dev/null || true; } | wc -l | tr -d ' '; }

printf 'cond\tcase\trep\twords\tcontrast\tcontrast_per_1k\temdash\thas_grade\n' >"$tsv"

for f in "$outdir"/*.txt; do
  [ -e "$f" ] || continue
  base="$(basename "$f" .txt)"
  cond="${base%%__*}"; rest="${base#*__}"; case_id="${rest%%__*}"; rep="${rest##*__}"

  words=$(wc -w <"$f" | tr -d ' ')
  contrast=$(count "$f" "$CONTRAST")
  emdash=$(count "$f" '—')
  grade=$(count "$f" "$GRADE")
  [ "$grade" -gt 0 ] && grade=1 || grade=0

  per1k=$(awk -v c="$contrast" -v w="$words" 'BEGIN{ printf (w>0 ? "%.2f" : "0.00"), (w>0 ? c*1000/w : 0) }')
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$cond" "$case_id" "$rep" "$words" "$contrast" "$per1k" "$emdash" "$grade" >>"$tsv"
done

echo "wrote $tsv ($(($(wc -l <"$tsv") - 1)) rows)"
echo
awk -F'\t' 'NR>1 {
    n[$1]++; w[$1]+=$4; c[$1]+=$5; e[$1]+=$7; g[$1]+=$8
  }
  END {
    printf "%-16s %5s %10s %9s %11s %8s %7s\n", "cond","n","mean_words","mean_ctr","ctr_per_1k","emdash","grade";
    for (k in n)
      printf "%-16s %5d %10.1f %9.2f %11.2f %8.2f %6d%%\n",
        k, n[k], w[k]/n[k], c[k]/n[k], c[k]*1000/w[k], e[k]/n[k], 100*g[k]/n[k];
  }' "$tsv" | sort -k5 -n
