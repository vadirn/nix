#!/usr/bin/env python3
"""Construction rate in real conversations, from the Claude Code transcripts.

The synthetic harness answers "does this edit change the prose", on six prompts
written to provoke the construction. This answers "does it change the prose I
actually get", on everything that has been said. The two are not
interchangeable: the harness compares arms under one file, this observes one
arm — whatever is deployed — over time, so an edit shows up as a break in a
series rather than as a difference between conditions.

Both use detector.py, and `detector.py --verify` holds it to score.sh, so a
transcript rate and an arm mean are in the same units.

Counting: rate is summed contrast over summed words per bucket, never a mean of
per-message rates. Most assistant turns are a line or two of narration, where
one hit reads as 80 per 1k and would swamp any bucket it landed in.

Usage:
    python3 transcripts.py                      # by week, prose turns only
    python3 transcripts.py --by month
    python3 transcripts.py --min-words 0        # every turn, narration included
    python3 transcripts.py --split 2026-07-22   # before/after rate-ratio test
    python3 transcripts.py --by week --project nix
"""

import argparse
import glob
import json
import math
import os
import sys
from collections import defaultdict
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from detector import measure  # noqa: E402

PROJECTS = os.path.expanduser("~/.claude/projects")


def turns(project=None, include_sidechains=False):
    """Yield one record per assistant text block, deduplicated by uuid.

    Sidechains are subagent output and never reach the user, so they are out by
    default: they would measure a different population under a different prompt.
    """
    seen = set()
    pattern = os.path.join(PROJECTS, f"*{project}*" if project else "*", "*.jsonl")
    for path in sorted(glob.glob(pattern)):
        with open(path, errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if rec.get("type") != "assistant":
                    continue
                if rec.get("isSidechain") and not include_sidechains:
                    continue
                uuid = rec.get("uuid")
                if uuid in seen:
                    continue
                seen.add(uuid)

                content = rec.get("message", {}).get("content")
                if not isinstance(content, list):
                    continue
                text = "\n".join(
                    b.get("text", "") for b in content
                    if isinstance(b, dict) and b.get("type") == "text"
                )
                if not text.strip():
                    continue

                ts = rec.get("timestamp")
                if not ts:
                    continue
                # Stored UTC; bucket in local time so a day means the user's day.
                when = datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone()
                yield when, rec.get("message", {}).get("model", "?"), text


def bucket_key(when, by):
    if by == "day":
        return when.strftime("%Y-%m-%d")
    if by == "week":
        return when.strftime("%G-W%V")
    return when.strftime("%Y-%m")


def collect(args):
    rows = []
    for when, model, text in turns(args.project, args.sidechains):
        m = measure(text)
        if m["words"] < args.min_words:
            continue
        rows.append((when, model, m))
    return rows


def rate(contrast, words):
    return 1000 * contrast / words if words else 0.0


def series(rows, by):
    agg = defaultdict(lambda: {"turns": 0, "words": 0, "contrast": 0, "staccato": 0})
    for when, _, m in rows:
        a = agg[bucket_key(when, by)]
        a["turns"] += 1
        a["words"] += m["words"]
        a["contrast"] += m["contrast"]
        a["staccato"] += m["staccato"]

    print(f"{'period':<10} {'turns':>6} {'words':>8} {'ctr':>5} {'ctr/1k':>7} {'stac/1k':>8}")
    for key in sorted(agg):
        a = agg[key]
        print(f"{key:<10} {a['turns']:>6} {a['words']:>8} {a['contrast']:>5} "
              f"{rate(a['contrast'], a['words']):>7.2f} {rate(a['staccato'], a['words']):>8.2f}")

    tw = sum(a["words"] for a in agg.values())
    tc = sum(a["contrast"] for a in agg.values())
    ts = sum(a["staccato"] for a in agg.values())
    tt = sum(a["turns"] for a in agg.values())
    print(f"{'-' * 48}")
    print(f"{'all':<10} {tt:>6} {tw:>8} {tc:>5} {rate(tc, tw):>7.2f} {rate(ts, tw):>8.2f}")


def split(rows, date, metric):
    """Poisson rate-ratio test across a cut date.

    Counts per unit of exposure, so the variance is the count itself, and the
    right comparison is of two rates rather than of two per-message means.
    """
    cut = datetime.fromisoformat(date).astimezone()
    before = {"words": 0, "n": 0, "turns": 0}
    after = {"words": 0, "n": 0, "turns": 0}
    for when, _, m in rows:
        side = before if when < cut else after
        side["words"] += m["words"]
        side["n"] += m[metric]
        side["turns"] += 1

    if not (before["words"] and after["words"]):
        sys.exit(f"one side of {date} is empty; nothing to compare")

    r_before = rate(before["n"], before["words"])
    r_after = rate(after["n"], after["words"])
    se = math.sqrt(before["n"] / before["words"] ** 2 + after["n"] / after["words"] ** 2) * 1000
    z = (r_after - r_before) / se if se else 0.0

    print(f"metric: {metric}   cut: {date}\n")
    print(f"{'side':<8} {'turns':>6} {'words':>8} {'n':>5} {'per 1k':>7}")
    print(f"{'before':<8} {before['turns']:>6} {before['words']:>8} {before['n']:>5} {r_before:>7.2f}")
    print(f"{'after':<8} {after['turns']:>6} {after['words']:>8} {after['n']:>5} {r_after:>7.2f}")
    change = (r_after / r_before - 1) * 100 if r_before else float("nan")
    print(f"\nchange {change:+.0f}%   z = {z:+.2f}")
    if abs(z) < 2:
        need = math.ceil(before["words"] * (2 / abs(z)) ** 2) if z else 0
        print(f"verdict: unresolved — |z| < 2. "
              f"{'~%d words per side would resolve it' % need if z else 'no signal yet'}")
    else:
        print(f"verdict: {'rose' if z > 0 else 'fell'} — |z| >= 2")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--by", choices=("day", "week", "month"), default="week")
    p.add_argument("--min-words", type=int, default=80,
                   help="floor isolating prose turns from narration (default 80)")
    p.add_argument("--project", help="substring of the project dir name")
    p.add_argument("--sidechains", action="store_true", help="include subagent output")
    p.add_argument("--split", metavar="DATE", help="before/after rate-ratio test")
    p.add_argument("--metric", choices=("contrast", "staccato"), default="contrast")
    args = p.parse_args()

    rows = collect(args)
    if not rows:
        sys.exit("no turns matched")
    if args.split:
        split(rows, args.split, args.metric)
    else:
        series(rows, args.by)


if __name__ == "__main__":
    main()
