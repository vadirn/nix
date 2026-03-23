#!/usr/bin/env python3
"""Block dangerous Bash commands by parsing tokens, not raw regex.

Handles git commands (push, config, reset --hard, branch -D), sudo, chmod 777,
obsidian destructive commands, and git -C.

Uses shlex.split to avoid false-positives on text inside quoted arguments
(e.g. git commit -m "block git push" should not trigger the push rule).
"""
import json
import re
import shlex
import sys


def deny(reason: str):
    json.dump({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }, sys.stdout)
    sys.exit(0)


def get_git_invocations(tokens: list[str]) -> list[tuple[str, list[str]]]:
    """Extract (subcommand, remaining_args) for each `git` invocation."""
    results = []
    i = 0
    while i < len(tokens):
        if tokens[i] == "git":
            j = i + 1
            # Skip git-level flags that take a value
            while j < len(tokens) and tokens[j].startswith("-"):
                if tokens[j] in ("-C", "-c", "--git-dir", "--work-tree"):
                    j += 2
                else:
                    j += 1
            if j < len(tokens) and not tokens[j].startswith("-"):
                subcmd = tokens[j]
                args = tokens[j + 1:]
                results.append((subcmd, args))
            i = j + 1
        else:
            i += 1
    return results


def check(command: str):
    # --- Token-based checks (quote-aware) ---
    try:
        tokens = shlex.split(command)
    except ValueError:
        tokens = []

    for subcmd, args in get_git_invocations(tokens):
        if subcmd == "push":
            if any(a in ("-f", "--force", "--force-with-lease") for a in args):
                deny("Blocked: force push overwrites remote history.")
            deny("Blocked: git push must be done manually.")

        if subcmd == "reset" and "--hard" in args:
            deny("Blocked: git reset --hard discards uncommitted changes.")

        if subcmd == "branch" and "-D" in args:
            deny("Blocked: git branch -D force-deletes without merge check.")

        if subcmd == "config":
            deny("Blocked: git config changes persist and affect all future commits.")

    if "sudo" in tokens:
        deny("Blocked: sudo runs commands as root. Too risky.")

    if "chmod" in tokens and "777" in tokens:
        deny("Blocked: chmod 777 makes files world-writable.")

    # --- Regex checks for patterns that don't appear in quoted args ---
    # git -C: always a top-level flag, safe to regex
    if re.search(r'(^|[\s;]|&&|\|)git\s+-C\s', command):
        deny("Use plain `git` — you are already in the repo.")

    # obsidian destructive subcommands
    obsidian_re = (
        r'(^|[\s;]|&&|\|)obsidian\s+'
        r'(eval|delete\s.*permanent|plugin:(un)?install|dev:cdp|command|history:restore)'
        r'(\s|$)'
    )
    if re.search(obsidian_re, command):
        deny("Blocked: this obsidian subcommand can cause data loss or run arbitrary code.")


def main():
    data = json.load(sys.stdin)
    command = data.get("tool_input", {}).get("command", "")
    if command:
        check(command)


if __name__ == "__main__":
    main()
