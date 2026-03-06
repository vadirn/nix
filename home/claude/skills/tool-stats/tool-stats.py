#!/usr/bin/env python3
"""Analyze CLI tool usage across Claude Code session transcripts."""

import json
import os
import sys
from collections import Counter, defaultdict
from pathlib import Path

READONLY_TOOLS = {
    "grep", "ls", "cat", "find", "which", "date", "head", "wc",
    "jq", "file", "readlink", "tail", "base64", "ps", "command",
    "whoami", "pwd", "hostname", "uname", "env", "printenv",
    "type", "man", "less", "more", "stat", "du", "df",
}


def extract_cli_tool(command: str) -> str | None:
    """Extract the first meaningful CLI tool from a Bash command string."""
    cmd = command.strip()
    if not cmd or cmd.startswith("#"):
        return None
    first = cmd.split()[0]
    # Skip env var assignments and prefixes
    while "=" in first and len(cmd.split(None, 1)) > 1:
        cmd = cmd.split(None, 1)[1]
        first = cmd.split()[0]
    return first


def scan_sessions(sessions_dir: Path) -> Counter:
    """Scan all JSONL session files in a directory for Bash tool calls."""
    tools = Counter()
    for f in sessions_dir.glob("*.jsonl"):
        with open(f) as fh:
            for line in fh:
                try:
                    data = json.loads(line)
                    content = data.get("message", {}).get("content", [])
                    if not isinstance(content, list):
                        continue
                    for block in content:
                        if not isinstance(block, dict):
                            continue
                        if block.get("type") == "tool_use" and block.get("name") == "Bash":
                            cmd = block.get("input", {}).get("command", "")
                            tool = extract_cli_tool(cmd)
                            if tool:
                                tools[tool] += 1
                except Exception:
                    pass
    return tools


def format_table(tools: Counter, top_n: int) -> str:
    lines = []
    lines.append(f"| {'Tool':<25} | {'Count':>5} | {'Type':<10} |")
    lines.append(f"|{'-'*27}|{'-'*7}|{'-'*12}|")
    for tool, count in tools.most_common(top_n):
        basename = Path(tool).name if "/" in tool else tool
        kind = "readonly" if basename in READONLY_TOOLS else ""
        lines.append(f"| {tool:<25} | {count:>5} | {kind:<10} |")
    total = sum(tools.values())
    ro = sum(c for t, c in tools.items() if (Path(t).name if "/" in t else t) in READONLY_TOOLS)
    lines.append(f"|{'-'*27}|{'-'*7}|{'-'*12}|")
    lines.append(f"| {'TOTAL':<25} | {total:>5} | ro: {ro:<6} |")
    return "\n".join(lines)


def main():
    args = sys.argv[1:]
    top_n = 30
    fmt = "table"
    scan_all = False
    project = None

    i = 0
    while i < len(args):
        if args[i] == "--top" and i + 1 < len(args):
            top_n = int(args[i + 1])
            i += 2
        elif args[i] == "--format" and i + 1 < len(args):
            fmt = args[i + 1]
            i += 2
        elif args[i] == "--all":
            scan_all = True
            i += 1
        elif args[i] == "--project" and i + 1 < len(args):
            project = args[i + 1]
            i += 2
        else:
            i += 1

    base = Path.home() / ".claude" / "projects"

    if scan_all:
        tools = Counter()
        project_count = 0
        for d in base.iterdir():
            if d.is_dir() and d.name != "memory":
                tools += scan_sessions(d)
                project_count += 1
        label = f"all projects ({project_count} projects)"
    else:
        cwd = project or os.getcwd()
        project_key = "-" + cwd.replace("/", "-").lstrip("-")
        sessions_dir = base / project_key
        if not sessions_dir.is_dir():
            print(f"No sessions found for {cwd}", file=sys.stderr)
            sys.exit(1)
        tools = scan_sessions(sessions_dir)
        label = cwd

    if not tools:
        print("No Bash tool calls found.")
        return

    if fmt == "json":
        result = {
            "scope": label,
            "total_calls": sum(tools.values()),
            "tools": [{"tool": t, "count": c} for t, c in tools.most_common(top_n)],
        }
        json.dump(result, sys.stdout, indent=2)
        print()
    else:
        print(f"Scope: {label}")
        print()
        print(format_table(tools, top_n))


if __name__ == "__main__":
    main()
