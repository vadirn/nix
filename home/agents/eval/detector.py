#!/usr/bin/env python3
"""The construction detector, shared by the synthetic harness and the transcript
metric so both report the same number.

`score.sh` implements the same pattern in ripgrep syntax. The two must agree, or
a transcript rate cannot be compared against an arm mean. `--verify` checks that
against a scored corpus and is the only thing licensing that comparison.

Usage:
    python3 detector.py --verify [corpus]   # differential test against score.sh
    python3 detector.py <file>...           # words and counts per file
"""

import re
import sys
import os
import csv

# Same alternation as score.sh. POSIX [[:space:]] becomes \s; [^.] matches
# newlines in both engines, so the {0,80} windows span lines identically.
CONTRAST = re.compile(
    r",\s+not\s+"
    r"|;\s+not\s+"
    r"|\brather than\b"
    r"|\binstead of\b"
    r"|\bnot just\b[^.]{0,80}\bbut\b"
    r"|\bit'?s not\b[^.]{0,80}\bit'?s\b",
    re.IGNORECASE,
)

# Sentence splitting, which the staccato form needs and a bare [.!?] cannot do
# here: this corpus is full of `AGENTS.md`, `~/.claude`, and `refactor-state.md`,
# and splitting on the period inside those shreds every sentence that mentions a
# file. Code spans and wikilinks are masked first, since their punctuation is
# never prose punctuation.
_BOUNDARY = re.compile(r"(?<=[.!?])\s+(?=[A-Z])")
_TAIL = re.compile(r"\S+$")
_EXT = re.compile(r"\.(md|py|sh|ts|tsx|js|json|jsonl|rs|toml|nix|yml|yaml|txt|lock)$", re.IGNORECASE)


def sentences(text):
    text = re.sub(r"`[^`]*`", "CODE", text)
    text = re.sub(r"\[\[[^\]]*\]\]", "LINK", text)
    out, buf = [], ""
    for chunk in _BOUNDARY.split(text):
        buf = f"{buf} {chunk}".strip() if buf else chunk
        tail = _TAIL.search(buf)
        if tail and (_EXT.search(tail.group(0)) or "/" in tail.group(0)):
            continue  # the boundary fell inside a path; keep accumulating
        out.append(buf)
        buf = ""
    if buf:
        out.append(buf)
    return out


# The staccato form CONTRAST misses: the clipped register, as in "A. Not B. Not
# C." Counted separately and never folded into CONTRAST, so the existing series
# stays comparable.
#
# Wide by choice — the whole clipped rhythm, negation or otherwise. Narrowing to
# negation openers ("Not yet built.") drops it eightfold and leaves out most of
# what the register consists of: "Committing step 2.", "Auto-commits enabled.",
# "It arrived as drift."
#
# A fragment is a sentence after the first that runs six words or fewer and
# carries no finite auxiliary or copula. Sentences containing a newline are
# markdown structure — list markers, headings — rather than prose rhythm, and
# would otherwise count "Three coordinated edits:\n\n**1." as a fragment.
_AUX = re.compile(
    r"\b(?:is|are|was|were|be|been|being|am|has|have|had|does|do|did"
    r"|will|would|can|could|should|must|may|might|'s|'re|'ve)\b",
    re.IGNORECASE,
)


def staccato(text):
    n = 0
    for i, sentence in enumerate(sentences(text)):
        s = sentence.strip()
        if not i or "\n" in s or not s[:1].isalpha():
            continue
        if len(s.split()) <= 6 and not _AUX.search(s):
            n += 1
    return n

GRADE = re.compile(r"\b(?:10|[0-9])/10\b|\bconfidence[: ]", re.IGNORECASE)


def measure(text):
    return {
        "words": len(text.split()),
        "contrast": len(CONTRAST.findall(text)),
        "staccato": staccato(text),
        "emdash": text.count("—"),
        "has_grade": 1 if GRADE.search(text) else 0,
    }


def verify(corpus):
    """Re-measure a scored corpus and diff against what score.sh wrote."""
    data = os.environ.get("AGENTS_EVAL_DATA") or os.path.expanduser(
        "~/Documents/vault/35 experiments/2026-07-22-agentsmd-archetype-arms.files"
    )
    tsv = os.path.join(data, "results", f"{corpus}.tsv")
    outdir = os.path.join(data, "corpus", corpus)
    if not os.path.exists(tsv):
        sys.exit(f"no results for {corpus}; run: bash score.sh {corpus}")

    checked = mismatched = 0
    with open(tsv, newline="") as fh:
        for row in csv.DictReader(fh, delimiter="\t"):
            name = f"{row['cond']}__{row['case']}__{row['rep']}.txt"
            path = os.path.join(outdir, name)
            with open(path) as f:
                got = measure(f.read())
            checked += 1
            for key in ("words", "contrast", "emdash", "has_grade"):
                if got[key] != int(row[key]):
                    mismatched += 1
                    print(f"MISMATCH {name} {key}: rg={row[key]} py={got[key]}")
                    break

    verdict = "agree" if not mismatched else f"DIVERGE on {mismatched}"
    print(f"{corpus}: {checked} files checked, {verdict}")
    return 1 if mismatched else 0


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--verify":
        corpora = sys.argv[2:] or ["claude", "glm"]
        sys.exit(max(verify(c) for c in corpora))
    for path in sys.argv[1:]:
        with open(path) as f:
            m = measure(f.read())
        print(f"{path}\t{m['words']}\t{m['contrast']}\t{m['staccato']}")
