#!/usr/bin/env python3
"""Grade design eval outputs against structural assertions."""
import json
import re
import sys
from pathlib import Path

EVALS_DIR = Path(__file__).parent
EVALS_FILE = EVALS_DIR / "evals.json"


def count_designs(text: str) -> int:
    """Count design sections in the output."""
    patterns = [
        r'(?i)##\s+design\s+\d',
        r'(?i)##\s+(?:approach|option|alternative|variant)\s+\d',
        r'(?i)##\s+\d+[\.\):]',
    ]
    count = 0
    for p in patterns:
        matches = re.findall(p, text)
        if matches:
            count = max(count, len(matches))
    return count


def check_designs_differ(text: str) -> tuple[bool, str]:
    """Check that designs have distinct constraint labels."""
    design_pattern = r'(?i)##\s+(?:design|approach|option|alternative|variant)\s+\d[^\n]*'
    headers = re.findall(design_pattern, text)
    if len(headers) < 2:
        return False, f"found {len(headers)} design headers"
    unique = set(h.lower().strip() for h in headers)
    if len(unique) >= 2:
        return True, f"{len(unique)} distinct design headers"
    return False, "design headers are not distinct"


def check_per_design(text: str, check_type: str) -> tuple[bool, str]:
    """Check that each design section contains required elements."""
    designs = re.split(r'(?i)(?=##\s+(?:design|approach|option|alternative|variant)\s+\d)', text)
    designs = [d for d in designs if d.strip()]

    if len(designs) < 2:
        designs = re.split(r'(?=##\s+\d+[\.\):])', text)
        designs = [d for d in designs if d.strip()]

    if len(designs) < 2:
        return False, "could not split into design sections"

    checks = {
        "has_signatures": [r'(?i)(?:interface|signature|schema|type |struct |class |def |fn |func |```)', "signature/schema"],
        "has_usage": [r'(?i)(?:usage|example|usage example|how to use|```)', "usage example"],
        "has_tradeoffs": [r'(?i)(?:trade.?off|downside|limitation|cost|sacrifice|accept)', "tradeoffs"],
    }

    if check_type not in checks:
        return False, f"unknown check: {check_type}"

    pattern, label = checks[check_type]
    passing = 0
    for d in designs[1:]:  # skip preamble
        if re.search(pattern, d):
            passing += 1

    total = len(designs) - 1
    passed = passing >= total * 0.6  # at least 60% of designs
    return passed, f"{passing}/{total} designs have {label}"


def check_comparison(text: str) -> tuple[bool, str]:
    """Check for a comparison section."""
    patterns = [
        r'(?i)##\s+(?:design\s+)?comparison',
        r'(?i)##\s+comparing',
        r'(?i)##\s+analysis',
        r'(?i)##\s+evaluation',
        r'(?i)##\s+trade.?off',
    ]
    for p in patterns:
        if re.search(p, text):
            return True, f"matched: {p}"
    return False, "no comparison section found"


def check_synthesis(text: str) -> tuple[bool, str]:
    """Check for a synthesis/recommendation section."""
    patterns = [
        r'(?i)##\s+synthesis',
        r'(?i)##\s+recommend',
        r'(?i)##\s+conclusion',
        r'(?i)##\s+verdict',
        r'(?i)##\s+final',
        r'(?i)##\s+summary',
        r'(?i)\brecommend(?:ation|ed)?\b.*(?:design|approach|option)',
    ]
    for p in patterns:
        if re.search(p, text):
            return True, f"matched: {p}"
    return False, "no synthesis section found"


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
        output_file = EVALS_DIR / iteration / eval_id / variant / "outputs" / "design.md"
        if not output_file.exists():
            results[variant] = {"error": f"File not found: {output_file}", "pass": 0, "fail": 0, "total": 0}
            continue

        text = output_file.read_text()
        word_count = len(text.split())
        checks = []

        for a in eval_cfg["assertions"]["structural"]:
            aid = a["id"]
            desc = a["check"]
            atype = a["type"]
            passed = False
            detail = ""

            if atype == "min_designs":
                count = count_designs(text)
                passed = count >= a["expected"]
                detail = f"found {count}, expected >= {a['expected']}"
            elif atype == "designs_differ":
                passed, detail = check_designs_differ(text)
            elif atype in ("has_signatures", "has_usage", "has_tradeoffs"):
                passed, detail = check_per_design(text, atype)
            elif atype == "has_comparison":
                passed, detail = check_comparison(text)
            elif atype == "has_synthesis":
                passed, detail = check_synthesis(text)
            elif atype == "word_range":
                passed = a["min"] <= word_count <= a["max"]
                detail = f"{word_count} words, expected {a['min']}-{a['max']}"
            else:
                detail = f"unknown type: {atype}"

            checks.append({"id": aid, "check": desc, "passed": passed, "detail": detail})

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

    print("=" * 70)
    print("DESIGN SKILL EVAL RESULTS")
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

    out_path = EVALS_DIR / "results.json"
    with open(out_path, "w") as f:
        json.dump(all_results, f, indent=2)
    print(f"\nDetailed results saved to {out_path}")

    if any_fail:
        sys.exit(1)


if __name__ == "__main__":
    main()
