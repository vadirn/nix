#!/usr/bin/env bash
# Welch t-test of every arm against a baseline, on one metric.
#
# Exists because arm means alone have repeatedly misled this project: a GLM
# result at t=1.83 with n=30 collapsed to t=1.08 at n=71. Read the verdict
# column, never the means.
#
# Convention: |t| < 2 is no effect. Say "not distinguishable", never "better".
# n80 is the per-arm n that would give 80% power at the observed effect size
# (16/d^2, two-sample rule of thumb). When n80 exceeds the n you ran, the arm
# is unresolved rather than null — running more reps can still move it.
#
# Usage: bash stats.sh <corpus> [metric] [baseline]
#   metric   column name from results/<corpus>.tsv (default contrast_per_1k)
#   baseline arm to compare against (default a-current)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
. "$here/config.sh"
corpus="${1:-claude}"
metric="${2:-contrast_per_1k}"
base="${3:-a-current}"
tsv="$AGENTS_EVAL_DATA/results/$corpus.tsv"
[ -s "$tsv" ] || { echo "no results for '$corpus'; run: bash score.sh $corpus" >&2; exit 1; }

awk -F'\t' -v metric="$metric" -v base="$base" '
NR==1 { for (i = 1; i <= NF; i++) if ($i == metric) col = i
        if (!col) { printf "no such metric: %s\n", metric > "/dev/stderr"; exit 1 }
        next }
{ n[$1]++; s[$1] += $col; q[$1] += $col * $col }
END {
  if (!(base in n)) { printf "no such arm: %s\n", base > "/dev/stderr"; exit 1 }
  for (k in n) { m[k] = s[k] / n[k]; v[k] = n[k] > 1 ? (q[k] - n[k] * m[k] * m[k]) / (n[k] - 1) : 0 }
  printf "metric: %s   baseline: %s\n\n", metric, base
  printf "%-16s %4s %8s %7s %7s %6s  %s\n", "arm", "n", "mean", "sd", "t", "n80", "verdict"
  printf "%-16s %4d %8.2f %7.2f %7s %6s  %s\n", base, n[base], m[base], sqrt(v[base]), "--", "--", "baseline"
  for (k in n) {
    if (k == base) continue
    se = sqrt(v[k] / n[k] + v[base] / n[base])
    t = se > 0 ? (m[k] - m[base]) / se : 0
    pooled = sqrt((v[k] + v[base]) / 2)
    d = pooled > 0 ? (m[k] - m[base]) / pooled : 0
    n80 = d != 0 ? 16 / (d * d) : 9999
    at = t < 0 ? -t : t
    verdict = at >= 2 ? (t > 0 ? "worse than baseline" : "better than baseline") \
            : (n80 > n[k] ? "unresolved (underpowered)" : "not distinguishable")
    printf "%-16s %4d %8.2f %7.2f %7.2f %6.0f  %s\n", k, n[k], m[k], sqrt(v[k]), t, n80, verdict
  }
}' "$tsv" >"$here/.stats.$$"
trap 'rm -f "$here/.stats.$$"' EXIT

# First four lines are the preamble, baseline included; sort the arms by t.
head -4 "$here/.stats.$$"
tail -n +5 "$here/.stats.$$" | sort -k5 -g
