#!/usr/bin/env python3
"""Grade probe eval outputs against structural assertions."""
import json
import re
import sys
from pathlib import Path

EVALS_DIR = Path(__file__).parent
EVALS_FILE = EVALS_DIR / "evals.json"


def count_questions(text: str) -> int:
    """Count numbered questions in the output.

    Matches patterns like:
    - ## 1. What about...
    - ## Question 1: ...
    - **1.** What about...
    - 1. **What about...**
    - ### 1. ...
    """
    patterns = [
        r'^#{1,3}\s+\d+[\.\):]',       # ## 1. or ## 1) or ## 1:
        r'^#{1,3}\s+Question\s+\d+',    # ## Question 1
        r'^\*\*\d+[\.\)]\*\*',          # **1.** or **1)**
        r'^\d+\.\s+\*\*',              # 1. **What...
    ]
    lines = text.split('\n')
    count = 0
    for line in lines:
        line = line.strip()
        for p in patterns:
            if re.match(p, line, re.IGNORECASE):
                count += 1
                break
    return count


def check_answers_present(text: str, question_count: int) -> tuple[bool, str]:
    """Check that questions are followed by substantive answer text.

    A recommended answer should appear after each question as a paragraph
    (not just the next question heading).
    """
    if question_count == 0:
        return False, "no questions found"

    # Split by question headers and check each section has content
    sections = re.split(r'(?m)^#{1,3}\s+\d+[\.\):]|^#{1,3}\s+Question\s+\d+|^\*\*\d+[\.\)]\*\*|^\d+\.\s+\*\*', text)
    # First section is preamble, skip it
    answer_sections = sections[1:] if len(sections) > 1 else []

    if not answer_sections:
        return False, "no answer sections found"

    short_answers = 0
    for section in answer_sections:
        words = len(section.split())
        if words < 20:
            short_answers += 1

    if short_answers > len(answer_sections) // 2:
        return False, f"{short_answers}/{len(answer_sections)} answers too short (<20 words)"

    return True, f"{len(answer_sections)} answers found"


def check_summary(text: str) -> tuple[bool, str]:
    """Check for a summary/resolution section."""
    patterns = [
        r'(?i)##\s+summary',
        r'(?i)##\s+resolution',
        r'(?i)##\s+resolved',
        r'(?i)##\s+conclusion',
        r'(?i)##\s+unresolved',
        r'(?i)##\s+open\s+(questions|items|issues)',
        r'(?i)##\s+decision\s+tree',
        r'(?i)##\s+verdict',
    ]
    for p in patterns:
        if re.search(p, text):
            return True, f"matched: {p}"
    return False, "no summary section found"


def check_contains_any(text: str, patterns: list[str]) -> tuple[bool, str]:
    """Check if text contains any of the given patterns (case-insensitive)."""
    text_lower = text.lower()
    found = [p for p in patterns if p.lower() in text_lower]
    if found:
        return True, f"found: {', '.join(found)}"
    return False, f"none of {patterns} found"


def grade_eval(eval_cfg: dict, iteration: str = "iteration-1") -> dict:
    eval_id = eval_cfg["id"]
    results = {}

    for variant in ["with_skill", "without_skill"]:
        output_file = EVALS_DIR / iteration / eval_id / variant / "outputs" / "probe.md"
        if not output_file.exists():
            results[variant] = {"error": f"File not found: {output_file}", "pass": 0, "fail": 0, "total": 0}
            continue

        text = output_file.read_text()
        word_count = len(text.split())
        checks = []

        # Process structural assertions
        for a in eval_cfg["assertions"]["structural"]:
            aid = a["id"]
            desc = a["check"]
            atype = a["type"]
            passed = False
            detail = ""

            if atype == "min_questions":
                count = count_questions(text)
                passed = count >= a["expected"]
                detail = f"found {count}, expected >= {a['expected']}"
            elif atype == "answers_present":
                qcount = count_questions(text)
                passed, detail = check_answers_present(text, qcount)
            elif atype == "has_summary":
                passed, detail = check_summary(text)
            elif atype == "word_range":
                passed = a["min"] <= word_count <= a["max"]
                detail = f"{word_count} words, expected {a['min']}-{a['max']}"
            else:
                detail = f"unknown type: {atype}"

            checks.append({"id": aid, "check": desc, "passed": passed, "detail": detail})

        # Process eval-specific assertions
        for a in eval_cfg["assertions"]["eval_specific"]:
            aid = a["id"]
            desc = a["check"]
            atype = a["type"]
            passed = False
            detail = ""

            if atype == "contains_any":
                passed, detail = check_contains_any(text, a["patterns"])
            elif atype == "human_review":
                passed = True
                detail = "requires human review"
            else:
                detail = f"unknown type: {atype}"

            checks.append({"id": aid, "check": desc, "passed": passed, "detail": detail})

        pass_count = sum(1 for c in checks if c["passed"])
        fail_count = sum(1 for c in checks if not c["passed"])
        results[variant] = {
            "checks": checks,
            "pass": pass_count,
            "fail": fail_count,
            "total": len(checks),
            "score": f"{pass_count}/{len(checks)}",
            "word_count": word_count,
        }

    return {"eval_id": eval_id, "results": results}


def main():
    with open(EVALS_FILE) as f:
        evals = json.load(f)["evals"]

    all_results = []
    any_fail = False

    for ev in evals:
        result = grade_eval(ev)
        all_results.append(result)

    # Print summary
    print("=" * 70)
    print("PROBE SKILL EVAL RESULTS")
    print("=" * 70)

    for r in all_results:
        print(f"\n## {r['eval_id']}")
        for variant in ["with_skill", "without_skill"]:
            vr = r["results"][variant]
            if "error" in vr:
                print(f"  {variant}: {vr['error']}")
                continue
            print(f"  {variant}: {vr['score']} passed | {vr['word_count']} words")
            for c in vr["checks"]:
                status = "PASS" if c["passed"] else "FAIL"
                if not c["passed"]:
                    any_fail = True
                print(f"    [{status}] {c['id']}: {c['check']} ({c['detail']})")

    # Comparison summary
    print("\n" + "=" * 70)
    print("COMPARISON: with_skill vs without_skill")
    print("=" * 70)
    for r in all_results:
        ws = r["results"].get("with_skill", {})
        wo = r["results"].get("without_skill", {})
        ws_score = ws.get("pass", 0)
        wo_score = wo.get("pass", 0)
        ws_total = ws.get("total", 0)
        wo_total = wo.get("total", 0)
        ws_words = ws.get("word_count", 0)
        wo_words = wo.get("word_count", 0)
        delta = ws_score - wo_score
        sign = "+" if delta > 0 else ""
        print(f"  {r['eval_id']}: skill={ws_score}/{ws_total} baseline={wo_score}/{wo_total} delta={sign}{delta} | words: skill={ws_words} baseline={wo_words}")

    # Save JSON
    out_path = EVALS_DIR / "results.json"
    with open(out_path, "w") as f:
        json.dump(all_results, f, indent=2)
    print(f"\nDetailed results saved to {out_path}")

    if any_fail:
        sys.exit(1)


if __name__ == "__main__":
    main()
