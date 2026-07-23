#!/usr/bin/env python3
"""Paired (randomized-block) test of an arm against a baseline, blocking by case.

The arms run identical cases by construction, and case base rates span 20x
(improve-rule ~11.7 per 1k, merge-vs-rebase ~0.6). An unpaired Welch test carries
that spread as error variance and hides real effects: g-derhetoric read t=-1.76
unpaired and t=-2.23 blocked on the same data.

Method: collapse reps to a per-case mean for each arm, difference arm minus
baseline within each case, then a one-sample t-test on the K case-level
differences (df = K-1). Between-case variance cancels because every case
contributes one matched pair.

Usage: python3 blocked.py <corpus> [metric] [baseline]
"""

import csv
import math
import os
import sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("AGENTS_EVAL_DATA") or os.path.expanduser(
    "~/Documents/agent-calibration"
)


def load(corpus, metric):
    tsv = os.path.join(DATA, "results", f"{corpus}.tsv")
    if not os.path.exists(tsv):
        sys.exit(f"no results for {corpus}; run: bash score.sh {corpus}")
    # cond -> case -> list of metric values
    cells = defaultdict(lambda: defaultdict(list))
    with open(tsv, newline="") as fh:
        reader = csv.DictReader(fh, delimiter="\t")
        if metric not in reader.fieldnames:
            sys.exit(f"no such metric: {metric} (have {', '.join(reader.fieldnames)})")
        for row in reader:
            cells[row["cond"]][row["case"]].append(float(row[metric]))
    return cells


def case_means(cells, cond):
    return {case: sum(v) / len(v) for case, v in cells[cond].items()}


def paired_t(diffs):
    k = len(diffs)
    if k < 2:
        return float("nan"), k, float("nan")
    mean = sum(diffs) / k
    var = sum((d - mean) ** 2 for d in diffs) / (k - 1)
    se = math.sqrt(var / k)
    t = mean / se if se else 0.0
    return t, k, mean


def main():
    corpus = sys.argv[1] if len(sys.argv) > 1 else "claude-agentic"
    metric = sys.argv[2] if len(sys.argv) > 2 else "contrast_per_1k"
    base = sys.argv[3] if len(sys.argv) > 3 else "a-current"
    cells = load(corpus, metric)
    if base not in cells:
        sys.exit(f"no such baseline arm: {base}")

    base_means = case_means(cells, base)
    print(f"metric: {metric}   baseline: {base}   blocked by case\n")
    print(f"{'arm':<16} {'cases':>5} {'base':>7} {'arm':>7} {'delta':>7} {'t':>7}  verdict")
    print(f"{base:<16} {len(base_means):>5} "
          f"{sum(base_means.values())/len(base_means):>7.2f} {'--':>7} {'--':>7} {'--':>7}  baseline")

    for cond in sorted(cells):
        if cond == base:
            continue
        arm_means = case_means(cells, cond)
        shared = sorted(set(base_means) & set(arm_means))
        diffs = [arm_means[c] - base_means[c] for c in shared]
        t, k, mean_d = paired_t(diffs)
        b = sum(base_means[c] for c in shared) / len(shared)
        a = sum(arm_means[c] for c in shared) / len(shared)
        # t.025 for small df; the arms live at df 4-6, so a fixed 2.0 misleads.
        crit = {1: 12.71, 2: 4.30, 3: 3.18, 4: 2.78, 5: 2.57, 6: 2.45,
                7: 2.36, 8: 2.31, 9: 2.26, 10: 2.23}.get(k - 1, 2.20)
        if abs(t) >= crit:
            verdict = "better than baseline" if t < 0 else "worse than baseline"
        else:
            verdict = f"not significant (|t|<{crit:.2f}, df={k-1})"
        print(f"{cond:<16} {k:>5} {b:>7.2f} {a:>7.2f} {mean_d:>+7.2f} {t:>7.2f}  {verdict}")


if __name__ == "__main__":
    main()
