#!/usr/bin/env bash
# Rescores every stored corpus, prints the t-test report for each, and closes
# with the rate in real transcripts. Touches no API: free, and reproducible
# from what is already on disk.
#
# Read the two halves together. The arm table says which condition wins under
# prompts built to provoke the construction; the transcript rate says what the
# deployed file actually produces. They have differed by 5x.
#
# Usage: bash eval.sh [metric]      # default metric: contrast_per_1k
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
. "$here/config.sh"
metric="${1:-contrast_per_1k}"

echo "data: $AGENTS_EVAL_DATA"
echo
for dir in "$AGENTS_EVAL_DATA"/corpus/*/; do
  [ -d "$dir" ] || continue
  corpus="$(basename "$dir")"
  printf '=== %s ===\n' "$corpus"
  bash "$here/score.sh" "$corpus" >/dev/null
  bash "$here/stats.sh" "$corpus" "$metric"
  echo
done

# The detector must agree across both implementations, or the two halves below
# are in different units and the comparison is meaningless.
printf '=== detector parity ===\n'
python3 "$here/detector.py" --verify
echo

printf '=== real transcripts ===\n'
python3 "$here/transcripts.py" --by month
