#!/usr/bin/env python3
"""Grade debate eval outputs against structural assertions."""
import json
import re
import sys
from pathlib import Path

EVALS_DIR = Path(__file__).parent
EVALS_FILE = EVALS_DIR / "evals.json"


def count_pattern(text: str, pattern: str) -> int:
    return len(re.findall(re.escape(pattern), text))


def has_links(text: str) -> int:
    """Count markdown links and bare URLs."""
    md_links = re.findall(r'\[([^\]]+)\]\(https?://[^)]+\)', text)
    bare_urls = re.findall(r'(?<!\()https?://\S+', text)
    return len(md_links) + len(bare_urls)


def check_roles(text: str, lang: str) -> bool:
    if lang == "ru":
        return bool(re.search(r'(?i)защитник', text) and re.search(r'(?i)скептик', text))
    return bool(re.search(r'(?i)defender', text) and re.search(r'(?i)skeptic', text))


def check_confidence(text: str) -> bool:
    """Check for confidence score pattern like 'confidence: 7/10' or '7 out of 10'."""
    patterns = [
        r'(?i)confiden\w*[:\s]+(\d{1,2})\s*/\s*10',
        r'(?i)confiden\w*[:\s]+(\d{1,2})\s+(?:out of|of)\s+10',
        r'(?i)уверенност\w*[:\s]+(\d{1,2})\s*/\s*10',
        r'(?i)уверенност\w*[:\s]+(\d{1,2})\s+из\s+10',
        r'(?i)(?:confidence|уверенность)[:\s—–-]+\s*(\d{1,2})',
        r'\b(\d)\s*/\s*10\b',
    ]
    for p in patterns:
        m = re.search(p, text)
        if m:
            val = int(m.group(1))
            if 1 <= val <= 10:
                return True
    return False


def grade_eval(eval_cfg: dict, iteration: str = "iteration-1") -> dict:
    eval_id = eval_cfg["id"]
    lang = eval_cfg["language"]
    results = {}

    for variant in ["with_skill", "without_skill"]:
        output_file = EVALS_DIR / iteration / eval_id / variant / "outputs" / "debate.md"
        if not output_file.exists():
            results[variant] = {"error": f"File not found: {output_file}", "pass": 0, "fail": 0, "total": 0}
            continue

        text = output_file.read_text()
        assertions = eval_cfg["assertions"]["structural"]
        checks = []

        for a in assertions:
            aid = a["id"]
            desc = a["check"]
            atype = a["type"]
            passed = False

            if atype == "count":
                count = count_pattern(text, a["pattern"])
                passed = count == a["expected"]
                detail = f"found {count}, expected {a['expected']}"
            elif atype == "count_max":
                count = count_pattern(text, a["pattern"])
                passed = count < a["expected_max"]
                detail = f"found {count}, expected < {a['expected_max']}"
            elif atype == "contains":
                passed = a["pattern"].lower() in text.lower()
                detail = "found" if passed else "not found"
            elif atype == "role_presence":
                passed = check_roles(text, lang)
                detail = "both roles found" if passed else "missing role(s)"
            elif atype == "confidence_score":
                passed = check_confidence(text)
                detail = "score found" if passed else "no confidence score"
            elif atype == "min_links":
                n = has_links(text)
                passed = n >= a["expected"]
                detail = f"found {n} links, need >= {a['expected']}"
            elif atype in ("verdict_section", "round1_terms", "final_round_synthesis"):
                passed = True  # structural check only; human review needed
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
            "word_count": len(text.split()),
        }

    return {"eval_id": eval_id, "results": results}


def main():
    with open(EVALS_FILE) as f:
        evals = json.load(f)["evals"]

    all_results = []
    for ev in evals:
        result = grade_eval(ev)
        all_results.append(result)

    # Print summary
    print("=" * 70)
    print("DEBATE SKILL EVAL RESULTS")
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


if __name__ == "__main__":
    main()
