#!/usr/bin/env python3
"""Extract stats from a Claude Code JSONL session transcript.

Outputs per-session metrics for tracking context effectiveness over time.
"""

import json
import os
import sys
from datetime import datetime
from pathlib import Path

# API pricing per million tokens
PRICING = {
    "claude-opus-4-6": {
        "input": 15.0,
        "cache_read": 0.30,
        "cache_create": 3.75,
        "output": 75.0,
    },
    "claude-sonnet-4-6": {
        "input": 3.0,
        "cache_read": 0.30,
        "cache_create": 3.75,
        "output": 15.0,
    },
    "claude-haiku-4-5-20251001": {
        "input": 0.80,
        "cache_read": 0.08,
        "cache_create": 1.0,
        "output": 4.0,
    },
    "claude-sonnet-4-5-20250929": {
        "input": 3.0,
        "cache_read": 0.30,
        "cache_create": 3.75,
        "output": 15.0,
    },
}


def cost_usd(model, input_tokens, cache_create, cache_read, output_tokens):
    if model not in PRICING:
        return None
    p = PRICING[model]
    return round(
        input_tokens / 1e6 * p["input"]
        + cache_create / 1e6 * p["cache_create"]
        + cache_read / 1e6 * p["cache_read"]
        + output_tokens / 1e6 * p["output"],
        4,
    )


def count_lines(s):
    if not s:
        return 0
    return s.count("\n") + (1 if not s.endswith("\n") else 0)


def parse_session(path: Path) -> dict:
    model = None
    api_turns = 0
    input_uncached = 0
    cache_create_tokens = 0
    cache_read_tokens = 0
    output_tokens = 0
    first_ts = None
    last_ts = None
    first_edit_turn = None
    lines_written = 0
    peak_context = 0

    with open(path) as f:
        for line in f:
            obj = json.loads(line)
            if obj.get("type") != "assistant" or "message" not in obj:
                continue

            msg = obj["message"]
            api_turns += 1

            if model is None:
                model = msg.get("model")

            usage = msg.get("usage", {})
            turn_input = usage.get("input_tokens", 0)
            turn_cache_create = usage.get("cache_creation_input_tokens", 0)
            turn_cache_read = usage.get("cache_read_input_tokens", 0)
            turn_output = usage.get("output_tokens", 0)

            input_uncached += turn_input
            cache_create_tokens += turn_cache_create
            cache_read_tokens += turn_cache_read
            output_tokens += turn_output

            turn_context = turn_input + turn_cache_create + turn_cache_read
            if turn_context > peak_context:
                peak_context = turn_context

            ts = obj.get("timestamp")
            if ts:
                if first_ts is None:
                    first_ts = ts
                last_ts = ts

            for block in msg.get("content", []):
                if block.get("type") != "tool_use":
                    continue
                name = block.get("name", "?")
                inp = block.get("input", {})

                if name == "Edit":
                    lines_written += count_lines(inp.get("new_string", ""))
                elif name == "Write":
                    lines_written += count_lines(inp.get("content", ""))

                if first_edit_turn is None and name in ("Edit", "Write"):
                    first_edit_turn = api_turns

    duration_min = None
    if first_ts and last_ts:
        t0 = datetime.fromisoformat(first_ts.replace("Z", "+00:00"))
        t1 = datetime.fromisoformat(last_ts.replace("Z", "+00:00"))
        duration_min = round((t1 - t0).total_seconds() / 60, 1)

    cost = cost_usd(
        model, input_uncached, cache_create_tokens, cache_read_tokens, output_tokens
    )

    result = {
        "session_id": path.stem,
        "date": first_ts[:10] if first_ts else None,
        "model": model,
        "cost_usd": cost,
        "lines_written": lines_written,
        "turns_to_edit": first_edit_turn,
        "api_turns": api_turns,
        "duration_min": duration_min,
        "peak_context": peak_context,
        "output_tokens": output_tokens,
    }
    return result


def find_latest_session(cwd: str) -> Path | None:
    """Find the most recently modified JSONL transcript for a project."""
    project_key = "-" + cwd.replace("/", "-").lstrip("-")
    sessions_dir = Path.home() / ".claude" / "projects" / project_key
    if not sessions_dir.is_dir():
        return None
    jsonl_files = list(sessions_dir.glob("*.jsonl"))
    if not jsonl_files:
        return None
    return max(jsonl_files, key=lambda p: p.stat().st_mtime)


def format_table(result: dict) -> str:
    labels = {
        "cost_usd": ("Cost", lambda v: f"${v:.2f}" if v is not None else "unknown"),
        "api_turns": ("API turns", str),
        "turns_to_edit": ("Turns to first edit", lambda v: str(v) if v else "none"),
        "lines_written": ("Lines written", lambda v: f"{v:,}"),
        "duration_min": ("Duration", lambda v: f"{v} min" if v else "unknown"),
        "output_tokens": ("Output tokens", lambda v: f"{v:,}"),
        "peak_context": ("Peak context", lambda v: f"{v:,} tokens"),
        "model": ("Model", str),
    }
    lines = []
    lines.append(f"| Metric | Value |")
    lines.append(f"|--------|-------|")
    for key, (label, fmt) in labels.items():
        val = result.get(key)
        lines.append(f"| {label} | {fmt(val)} |")
    return "\n".join(lines)


def main():
    args = sys.argv[1:]
    fmt = "json"
    if "--format" in args:
        idx = args.index("--format")
        if idx + 1 < len(args):
            fmt = args[idx + 1]
            args = args[:idx] + args[idx + 2:]

    if not args:
        print(
            f"Usage: {sys.argv[0]} [--format table|json] [--latest] <session.jsonl> [...]",
            file=sys.stderr,
        )
        sys.exit(1)

    paths = []
    if args[0] == "--latest":
        cwd = args[1] if len(args) > 1 else os.getcwd()
        latest = find_latest_session(cwd)
        if latest is None:
            print(f"No sessions found for {cwd}", file=sys.stderr)
            sys.exit(1)
        paths = [latest]
    else:
        for arg in args:
            p = Path(arg)
            if not p.exists():
                print(f"Not found: {arg}", file=sys.stderr)
                continue
            paths.append(p)

    results = []
    for p in paths:
        r = parse_session(p)
        if r["api_turns"] == 0:
            continue
        if r.get("model") == "<synthetic>":
            continue
        results.append(r)

    if not results:
        print("{}")
        print()
        return

    if fmt == "table":
        for r in results:
            print(format_table(r))
            print()
    elif len(results) == 1:
        json.dump(results[0], sys.stdout, indent=2)
        print()
    else:
        json.dump(results, sys.stdout, indent=2)
        print()


if __name__ == "__main__":
    main()
