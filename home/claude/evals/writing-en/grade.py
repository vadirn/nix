#!/usr/bin/env python3
"""Grader for writing-en skill evals.

Reads evals.json for assertion definitions, checks outputs in outputs/,
writes results.json with per-case scores, word counts, and timing.

Run: uv run home/claude/evals/writing-en/grade.py
"""

import json
import os
import re
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
EVALS_PATH = os.path.join(SCRIPT_DIR, "evals.json")
OUTPUTS_DIR = os.path.join(SCRIPT_DIR, "outputs")
RESULTS_PATH = os.path.join(SCRIPT_DIR, "results.json")


def word_count(text: str) -> int:
    return len(text.split())


def check_absent_pattern(text: str, pattern: str) -> tuple[bool, str]:
    """Check that pattern does NOT appear in text. Supports regex."""
    if re.search(pattern, text, re.IGNORECASE):
        match = re.search(pattern, text, re.IGNORECASE)
        return False, f"found: '{match.group()}'"
    return True, "absent"


def check_present_pattern(text: str, pattern: str) -> tuple[bool, str]:
    """Check that pattern DOES appear in text."""
    if re.search(pattern, text, re.IGNORECASE):
        return True, "present"
    return False, f"missing: '{pattern}'"


def check_word_ratio(input_text: str, output_text: str, max_ratio: float) -> tuple[bool, str]:
    """Check that output is shorter than input by the specified ratio."""
    input_wc = word_count(input_text)
    output_wc = word_count(output_text)
    if input_wc == 0:
        return True, "empty input"
    ratio = output_wc / input_wc
    passed = ratio <= max_ratio
    return passed, f"ratio={ratio:.2f} (max={max_ratio}, {input_wc}→{output_wc} words)"


def check_sentence_length_variance(text: str) -> tuple[bool, str]:
    """Check that sentences vary in length (not all 8-12 words)."""
    sentences = re.split(r"[.!?]+", text)
    sentences = [s.strip() for s in sentences if s.strip()]
    if len(sentences) < 3:
        return True, "too few sentences to check"
    lengths = [len(s.split()) for s in sentences]
    min_len = min(lengths)
    max_len = max(lengths)
    spread = max_len - min_len
    passed = spread >= 5
    return passed, f"lengths={lengths}, spread={spread} (min 5)"


def grade_eval(eval_case: dict, output_text: str) -> dict:
    """Grade one eval case. Returns dict with checks, pass/fail counts."""
    assertions = eval_case["assertions"]
    input_text = eval_case["input"]
    checks = []

    for pattern in assertions.get("absent_patterns", []):
        passed, detail = check_absent_pattern(output_text, pattern)
        checks.append({
            "type": "absent_pattern",
            "pattern": pattern,
            "passed": passed,
            "detail": detail,
        })

    for pattern in assertions.get("present_patterns", []):
        passed, detail = check_present_pattern(output_text, pattern)
        checks.append({
            "type": "present_pattern",
            "pattern": pattern,
            "passed": passed,
            "detail": detail,
        })

    if "max_word_ratio" in assertions:
        passed, detail = check_word_ratio(input_text, output_text, assertions["max_word_ratio"])
        checks.append({
            "type": "max_word_ratio",
            "passed": passed,
            "detail": detail,
        })

    if assertions.get("sentence_length_variance"):
        passed, detail = check_sentence_length_variance(output_text)
        checks.append({
            "type": "sentence_length_variance",
            "passed": passed,
            "detail": detail,
        })

    pass_count = sum(1 for c in checks if c["passed"])
    fail_count = len(checks) - pass_count

    return {
        "checks": checks,
        "pass": pass_count,
        "fail": fail_count,
        "total": len(checks),
        "score": f"{pass_count}/{len(checks)}",
        "input_words": word_count(input_text),
        "output_words": word_count(output_text),
    }


def load_timing(eval_id: str) -> float | None:
    """Load timing from meta file if it exists."""
    meta_path = os.path.join(OUTPUTS_DIR, f"{eval_id}.meta.json")
    if os.path.exists(meta_path):
        with open(meta_path) as f:
            meta = json.load(f)
        return meta.get("elapsed_seconds")
    return None


def main():
    with open(EVALS_PATH) as f:
        evals = json.load(f)

    if not os.path.isdir(OUTPUTS_DIR):
        print("No outputs directory found. Run the pipeline first.")
        sys.exit(0)

    results = []
    total_pass = 0
    total_fail = 0

    print(f"Grading {len(evals)} eval cases...\n")

    for eval_case in evals:
        eval_id = eval_case["id"]
        output_path = os.path.join(OUTPUTS_DIR, f"{eval_id}.md")

        if not os.path.exists(output_path):
            print(f"  SKIP {eval_id}: no output file")
            results.append({"eval_id": eval_id, "status": "skipped"})
            continue

        with open(output_path) as f:
            output_text = f.read()

        result = grade_eval(eval_case, output_text)
        result["eval_id"] = eval_id

        timing = load_timing(eval_id)
        if timing is not None:
            result["elapsed_seconds"] = timing

        results.append(result)
        total_pass += result["pass"]
        total_fail += result["fail"]

        status = "PASS" if result["fail"] == 0 else "FAIL"
        timing_str = f" ({timing:.1f}s)" if timing else ""
        print(f"  {status} {eval_id}: {result['score']} "
              f"({result['input_words']}→{result['output_words']} words){timing_str}")

        if result["fail"] > 0:
            for check in result["checks"]:
                if not check["passed"]:
                    print(f"       ✗ {check['type']}: {check['detail']}")

    print(f"\nTotal: {total_pass} passed, {total_fail} failed")

    try:
        with open(RESULTS_PATH, "w") as f:
            json.dump(results, f, indent=2)
        print(f"Results written to {RESULTS_PATH}")
    except OSError:
        print(json.dumps(results, indent=2))

    if total_fail > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
