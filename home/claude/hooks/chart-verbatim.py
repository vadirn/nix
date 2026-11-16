#!/usr/bin/env python3
"""PreToolUse on show_widget: deny a chart widget that drifted from its render.

The chart skill's render.ts prints a fragment the model copies into
show_widget's widget_code, and saves the same fragment to
~/.cache/chart-widgets/<id>.html, where <id> is the fragment's opening
data-chart attribute. A copy of a minified script can drift unnoticed, so this
hook compares the two and denies a mismatch, quoting the first difference, so
the model resends before the user sees a broken widget.

It fails open: a widget without data-chart, a missing record, or any error in
the hook lets the call through. Only a positive mismatch denies.

This guards the hand copy rather than removing it. Swapping the record in
through updatedInput would remove it, but that does not take effect: in a probe
on 2026-11-16 the hook returned updatedInput with "allow", and the widget still
drew the model's text. Which layer ignores the swap is unknown: the desktop app
may draw from the streamed tool call, or Claude Code may drop updatedInput for
this MCP tool.
"""
import json
import re
import sys
from pathlib import Path

RECORDS = Path.home() / ".cache" / "chart-widgets"
KEY = re.compile(r'<div data-chart="(mmd-[0-9a-f]{8})"')
CONTEXT = 80


def check(code: str) -> str | None:
    """Return a deny reason, or None to let the call through."""
    sent = code.strip()
    key = KEY.match(sent)
    if not key:
        return None
    record = RECORDS / f"{key.group(1)}.html"
    try:
        expected = record.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    if sent == expected:
        return None
    at = next(
        (i for i, (a, b) in enumerate(zip(sent, expected)) if a != b),
        min(len(sent), len(expected)),
    )
    lo, hi = max(0, at - CONTEXT), at + CONTEXT
    return (
        f"widget_code differs from the render.ts output recorded at {record}, "
        f"first at character {at} (sent {len(sent)} characters, the record has "
        f"{len(expected)}).\n"
        f"record: ...{expected[lo:hi]}...\n"
        f"sent:   ...{sent[lo:hi]}...\n"
        "Resend show_widget with the record's contents unchanged as widget_code."
    )


def main() -> None:
    try:
        code = json.load(sys.stdin)["tool_input"]["widget_code"]
        reason = check(code) if isinstance(code, str) else None
    except Exception:
        return
    if reason:
        print(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": reason,
            }
        }))


if __name__ == "__main__":
    main()
