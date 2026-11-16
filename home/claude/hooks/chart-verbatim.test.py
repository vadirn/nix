#!/usr/bin/env python3
"""Tests for chart-verbatim.py"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPT = Path(__file__).parent / "chart-verbatim.py"
PASS = 0
FAIL = 0

HOME = Path(tempfile.mkdtemp(prefix="chart-verbatim-"))
RECORDS = HOME / ".cache" / "chart-widgets"
RECORDS.mkdir(parents=True)

# The drift that prompted the hook: the pointerdown handler came out as the
# pointermove guard beside it, dropping the toolbar exclusion.
RIGHT = 'if(t.pointerType==="mouse"&&t.button!==0||s.contains(t.target))return;d.down(t)'
WRONG = 'if(t.pointerType==="mouse"&&t.buttons===0){if(u.delete(t.pointerId))d.set("idle");return}d.down(t)'


def fragment(key: str, handler: str) -> str:
    return (
        f'<div data-chart="{key}" style="padding:1rem 0"><svg></svg>'
        f'<script>(()=>{{e.addEventListener("pointerdown",(t)=>{{{handler}}})}})();</script></div>'
    )


RECORD = fragment("mmd-0123abcd", RIGHT)
(RECORDS / "mmd-0123abcd.html").write_text(RECORD, encoding="utf-8")


def run(stdin: str) -> str:
    result = subprocess.run(
        [sys.executable, str(SCRIPT)],
        input=stdin, capture_output=True, text=True,
        env={**os.environ, "HOME": str(HOME)},
    )
    assert result.returncode == 0, result.stderr
    return result.stdout


def payload(code) -> str:
    return json.dumps({"tool_name": "mcp__visualize__show_widget",
                       "tool_input": {"title": "t", "widget_code": code}})


def expect(desc: str, ok: bool):
    global PASS, FAIL
    if ok:
        PASS += 1
    else:
        FAIL += 1
        print(f"FAIL: {desc}")


def denies(stdin: str) -> str | None:
    out = run(stdin)
    if not out:
        return None
    decision = json.loads(out)["hookSpecificOutput"]
    return decision["permissionDecisionReason"] if decision["permissionDecision"] == "deny" else None


expect("an exact copy passes", denies(payload(RECORD)) is None)
expect("a trailing newline passes", denies(payload(RECORD + "\n")) is None)
expect("a leading newline passes", denies(payload("\n" + RECORD)) is None)
expect("a leading newline does not skip the check",
       denies(payload("\n" + fragment("mmd-0123abcd", WRONG))) is not None)

reason = denies(payload(fragment("mmd-0123abcd", WRONG)))
expect("the pointerdown drift is denied", reason is not None)
expect("the reason quotes the record's handler", reason is not None and "s.contains(t.target)" in reason)
expect("the reason quotes the sent handler", reason is not None and "u.delete(t.pointerId)" in reason)
expect("the reason names the record path", reason is not None and "mmd-0123abcd.html" in reason)

expect("a truncated copy is denied", denies(payload(RECORD[:-40])) is not None)
expect("a widget without data-chart passes", denies(payload("<p>hello</p>")) is None)
expect("a missing record passes", denies(payload(fragment("mmd-ffffffff", WRONG))) is None)
expect("a non-string widget_code passes", denies(payload(None)) is None)
expect("malformed JSON passes", run("{not json") == "")

print(f"{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
