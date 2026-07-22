#!/usr/bin/env bash
# Welch t-test of every arm against a baseline, on one metric.
#
# Exists because arm means alone have repeatedly misled this project: a GLM
# result at t=1.83 with n=30 collapsed to t=1.08 at n=71. Read the verdict
# column, never the means.
#
# Blocks by case when every arm covers the same case set, which is how the
# harness is built. Cases differ enormously in base rate — `improve-rule` runs
# at 11.7 per 1k against `merge-vs-rebase` at 0.6 — and carrying that spread as
# error variance hides real effects. On the de-rhetoric arm it was 37% of total
# variance, and blocking moved the verdict from t=-1.76 to t=-2.23.
#
# Convention: |t| < 2 is no effect. Say "not distinguishable", never "better".
# n80 is the per-arm n that would give 80% power at the observed effect size
# (16/d^2, two-sample rule of thumb). When n80 exceeds the n you ran, the arm
# is unresolved rather than null — running more reps can still move it.
#
# Usage: bash stats.sh <corpus> [metric] [baseline]
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
. "$here/config.sh"
corpus="${1:-claude}"
metric="${2:-contrast_per_1k}"
base="${3:-a-current}"
tsv="$AGENTS_EVAL_DATA/results/$corpus.tsv"
[ -s "$tsv" ] || { echo "no results for '$corpus'; run: bash score.sh $corpus" >&2; exit 1; }

awk -F'\t' -v metric="$metric" -v base="$base" '
NR==1 { for (i = 1; i <= NF; i++) { if ($i == metric) col = i; if ($i == "case") ccol = i }
        if (!col) { printf "no such metric: %s\n", metric > "/dev/stderr"; exit 1 }
        next }
{ arm[NR] = $1; kase[NR] = $(ccol); val[NR] = $col; rows = NR
  n[$1]++; seen[$1 SUBSEP $(ccol)] = 1; cases[$(ccol)] = 1
  csum[$(ccol)] += $col; ccount[$(ccol)]++ }
END {
  if (!(base in n)) { printf "no such arm: %s\n", base > "/dev/stderr"; exit 1 }

  # Block only when the design supports it: every arm must cover every case.
  blocked = 1
  for (a in n) for (c in cases) if (!((a SUBSEP c) in seen)) blocked = 0
  ncase = 0; for (c in cases) ncase++
  if (ncase < 2) blocked = 0

  for (r = 2; r <= rows; r++) {
    dev = blocked ? val[r] - csum[kase[r]] / ccount[kase[r]] : val[r]
    s[arm[r]] += dev; q[arm[r]] += dev * dev
    raw[arm[r]] += val[r]
  }
  for (k in n) {
    m[k] = s[k] / n[k]; v[k] = n[k] > 1 ? (q[k] - n[k] * m[k] * m[k]) / (n[k] - 1) : 0
    shown[k] = raw[k] / n[k]
  }

  printf "metric: %s   baseline: %s   %s\n\n", metric, base,
         blocked ? sprintf("blocked by case (%d cases)", ncase) : "unblocked"
  printf "%-16s %4s %8s %7s %7s %6s  %s\n", "arm", "n", "mean", "sd", "t", "n80", "verdict"
  printf "%-16s %4d %8.2f %7.2f %7s %6s  %s\n", base, n[base], shown[base], sqrt(v[base]), "--", "--", "baseline"
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
    printf "%-16s %4d %8.2f %7.2f %7.2f %6.0f  %s\n", k, n[k], shown[k], sqrt(v[k]), t, n80, verdict
  }
  if (metric == "has_grade")
    printf "\nnote: has_grade is a guard, and the verdict column reads lower as better. Read it per case instead: a drop is damage only where the case asks for a recommendation.\n"
  else if (blocked) printf "\nnote: sd and t are on case-residuals; mean is the raw rate.\n"
}' "$tsv" >"$here/.stats.$$"
trap 'rm -f "$here/.stats.$$"' EXIT

# awk emits: metric line, blank, header, baseline, then arms, then the footnote.
head -4 "$here/.stats.$$"
sed -n '5,$p' "$here/.stats.$$" | grep -v '^$' | grep -v '^note:' | sort -k5 -g
grep '^note:' "$here/.stats.$$" || true
