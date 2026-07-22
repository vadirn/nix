#!/usr/bin/env python3
"""Holds the detectors to their labelled cases.

The staccato rate was reported 86x low on 2026-07-22 because the detector had
data but no runner: nothing failed when the sentence splitter shredded every
filename. This is that runner. A detector change that breaks a case fails here,
before it reaches a transcript number anyone quotes.

Usage: python3 calibrate.py       # exit 1 on any failure
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from detector import CONTRAST, staccato  # noqa: E402

CALIB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "calib")

# Cases carrying a newline, which a line-oriented file cannot hold. Markdown
# structure must never read as prose rhythm.
STRUCTURAL = [
    ("The mapping falls out in three coordinated edits:\n\n**1. First one.", 0),
    ("Two things happened.\n\n- Cut.\n- Kept.", 0),
]


def cases(name):
    path = os.path.join(CALIB, name)
    with open(path) as fh:
        return [
            line.strip()
            for line in fh
            if line.strip() and not line.startswith("#")
        ]


def check(label, items, expect_hit, score):
    """expect_hit: True when every case must score >0, False when every case must score 0."""
    failures = []
    for text in items:
        n = score(text)
        if (n > 0) != expect_hit:
            failures.append((n, text))
    verdict = "ok" if not failures else f"FAIL {len(failures)}/{len(items)}"
    print(f"{label:<26} {len(items):>3} cases  {verdict}")
    for n, text in failures:
        print(f"    scored {n}: {text[:88]}")
    return len(failures)


def main():
    contrast = lambda t: len(CONTRAST.findall(t))  # noqa: E731
    bad = 0
    bad += check("contrast positives", cases("positives.txt"), True, contrast)
    bad += check("contrast negatives", cases("negatives.txt"), False, contrast)
    bad += check("staccato positives", cases("staccato-positives.txt"), True, staccato)
    bad += check("staccato negatives", cases("staccato-negatives.txt"), False, staccato)
    bad += check(
        "staccato structural",
        [t for t, _ in STRUCTURAL],
        False,
        staccato,
    )
    print("\ncalibration passes" if not bad else f"\n{bad} case(s) failing")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
