#!/usr/bin/env python3
"""Analyze prompt patterns across all Claude Code sessions."""

import argparse
import json
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path


def parse_args():
    p = argparse.ArgumentParser(description="Analyze Claude Code prompt history")
    p.add_argument("--top", type=int, default=15, help="Number of items per table (default: 15)")
    p.add_argument("--project", type=str, help="Filter to one project path")
    p.add_argument("--since", type=str, help="Filter by date (YYYY-MM-DD)")
    return p.parse_args()


def load_history(path, project_filter=None, since_filter=None):
    entries = []
    since_ts = None
    if since_filter:
        since_ts = datetime.strptime(since_filter, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp() * 1000

    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue

            if project_filter and entry.get("project", "") != project_filter:
                continue
            if since_ts and entry.get("timestamp", 0) < since_ts:
                continue

            entries.append(entry)
    return entries


def normalize(text):
    text = text.strip().lower()
    # collapse whitespace
    text = re.sub(r"\s+", " ", text)
    return text[:80]


def format_table(headers, rows):
    if not rows:
        return "  (none)\n"
    col_widths = [len(h) for h in headers]
    str_rows = []
    for row in rows:
        sr = [str(c) for c in row]
        str_rows.append(sr)
        for i, c in enumerate(sr):
            col_widths[i] = max(col_widths[i], len(c))

    sep = "  ".join("-" * w for w in col_widths)
    hdr = "  ".join(h.ljust(col_widths[i]) for i, h in enumerate(headers))
    lines = [hdr, sep]
    for sr in str_rows:
        lines.append("  ".join(sr[i].ljust(col_widths[i]) for i in range(len(headers))))
    return "\n".join(lines) + "\n"


def main():
    args = parse_args()
    history_path = Path.home() / ".claude" / "history.jsonl"
    if not history_path.exists():
        print(f"History file not found: {history_path}")
        return

    entries = load_history(history_path, args.project, args.since)
    if not entries:
        print("No entries found matching filters.")
        return

    # Timestamps
    timestamps = [e["timestamp"] for e in entries if "timestamp" in e]
    date_min = datetime.fromtimestamp(min(timestamps) / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
    date_max = datetime.fromtimestamp(max(timestamps) / 1000, tz=timezone.utc).strftime("%Y-%m-%d")

    projects = set(e.get("project", "") for e in entries)
    sessions = set(e.get("sessionId", "") for e in entries)

    # Split slash commands vs regular prompts
    slash_cmds = []
    prompts = []
    for e in entries:
        display = e.get("display", "").strip()
        if not display:
            continue
        if display.startswith("/"):
            # extract first word after /
            cmd = display.split()[0].lstrip("/").rstrip()
            if cmd:
                slash_cmds.append(cmd)
        else:
            prompts.append(display)

    # Summary
    print("## Summary\n")
    print(f"  Total prompts:    {len(entries)}")
    print(f"  Date range:       {date_min} .. {date_max}")
    print(f"  Unique projects:  {len(projects)}")
    print(f"  Unique sessions:  {len(sessions)}")
    if args.project:
        print(f"  Filter (project): {args.project}")
    if args.since:
        print(f"  Filter (since):   {args.since}")
    print()

    # By project
    print(f"## Top {args.top} Projects\n")
    project_counts = Counter(e.get("project", "(unknown)") for e in entries)
    rows = [(p, c) for p, c in project_counts.most_common(args.top)]
    print(format_table(["Project", "Count"], rows))

    # Slash commands
    print(f"## Slash Commands\n")
    cmd_counts = Counter(slash_cmds)
    rows = [(cmd, c) for cmd, c in cmd_counts.most_common(args.top)]
    print(format_table(["Command", "Count"], rows))

    # Top prompts (normalized, min 2 occurrences)
    print(f"## Top Prompts (min 2 occurrences)\n")
    normalized = [normalize(p) for p in prompts]
    prompt_counts = Counter(normalized)
    rows = [(text, c) for text, c in prompt_counts.most_common(args.top * 3) if c >= 2][:args.top]
    print(format_table(["Prompt", "Count"], rows))


if __name__ == "__main__":
    main()
