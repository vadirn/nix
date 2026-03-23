#!/usr/bin/env python3
"""Block dangerous Bash commands by parsing tokens, not raw regex.

Uses shlex.split to avoid false-positives on text inside quoted arguments
(e.g. git commit -m "block git push in hook" should not trigger the push rule).
"""
import json
import re
import shlex
import sys

# Git rules: (subcommand, required_args or None, deny message)
# Rules with required_args are checked first (more specific match).
# Rules with None match any invocation of that subcommand.
GIT_RULES = [
    ("push",   ("-f", "--force", "--force-with-lease"), "Blocked: force push overwrites remote history."),
    ("push",   None,                                    "Blocked: git push must be done manually."),
    ("reset",  ("--hard",),                             "Blocked: git reset --hard discards uncommitted changes."),
    ("branch", ("-D",),                                 "Blocked: git branch -D force-deletes without merge check."),
    ("config", None,                                    "Blocked: git config changes persist and affect all future commits."),
]

# Token rules: (token, deny message)
# Matches if the token appears as a top-level word in the parsed command.
TOKEN_RULES = [
    ("sudo", "Blocked: sudo runs commands as root. Too risky."),
]

# Token pair rules: (token_a, token_b, deny message)
# Matches if both tokens appear in the parsed command.
TOKEN_PAIR_RULES = [
    ("chmod", "777", "Blocked: chmod 777 makes files world-writable."),
]

# Regex rules: (pattern, deny message)
# Applied to the raw command string for patterns that don't appear in quoted args.
REGEX_RULES = [
    (
        r'(^|[\s;]|&&|\|)git\s+-C\s',
        "Use plain `git` — you are already in the repo.",
    ),
    (
        r'(^|[\s;]|&&|\|)obsidian\s+'
        r'(eval|delete\s.*permanent|plugin:(un)?install|dev:cdp|command|history:restore)'
        r'(\s|$)',
        "Blocked: this obsidian subcommand can cause data loss or run arbitrary code.",
    ),
]


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
            while j < len(tokens) and tokens[j].startswith("-"):
                if tokens[j] in ("-C", "-c", "--git-dir", "--work-tree"):
                    j += 2
                else:
                    j += 1
            if j < len(tokens) and not tokens[j].startswith("-"):
                results.append((tokens[j], tokens[j + 1:]))
            i = j + 1
        else:
            i += 1
    return results


def check(command: str):
    try:
        tokens = shlex.split(command)
    except ValueError:
        tokens = []

    # Git subcommand rules (token-based, quote-aware)
    for subcmd, args in get_git_invocations(tokens):
        for rule_subcmd, required_args, message in GIT_RULES:
            if subcmd != rule_subcmd:
                continue
            if required_args is None:
                deny(message)
            if any(a in args for a in required_args):
                deny(message)

    # Single-token rules
    for token, message in TOKEN_RULES:
        if token in tokens:
            deny(message)

    # Token-pair rules
    for token_a, token_b, message in TOKEN_PAIR_RULES:
        if token_a in tokens and token_b in tokens:
            deny(message)

    # Regex rules (raw string, for patterns safe from quoting issues)
    for pattern, message in REGEX_RULES:
        if re.search(pattern, command):
            deny(message)


def main():
    data = json.load(sys.stdin)
    command = data.get("tool_input", {}).get("command", "")
    if command:
        check(command)


if __name__ == "__main__":
    main()
