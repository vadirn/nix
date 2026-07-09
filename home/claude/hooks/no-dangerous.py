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
# Evaluated in order. Rules with required_args match only when at least one
# required arg is present. Rules with None match any invocation of that subcommand.
GIT_RULES = [
    ("push",   ("-f", "--force", "--force-with-lease"), "Blocked: force push overwrites remote history."),
    ("push",   None,                                    "Blocked: git push must be done manually."),
    ("reset",  ("--hard",),                             "Blocked: git reset --hard discards uncommitted changes."),
    ("branch", ("-D",),                                 "Blocked: git branch -D force-deletes without merge check."),
    # config is handled specially in check() — not here
]

TOKEN_RULES = [
    ("sudo", "Blocked: sudo runs commands as root. Too risky."),
]

TOKEN_PAIR_RULES = [
    ("chmod", "777", "Blocked: chmod 777 makes files world-writable."),
]

_REGEX_RULES = [
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
REGEX_RULES = [(re.compile(p), m) for p, m in _REGEX_RULES]

GIT_FLAGS_WITH_VALUE = frozenset(("-C", "-c", "--git-dir", "--work-tree"))


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
                if tokens[j] in GIT_FLAGS_WITH_VALUE:
                    j += 2
                else:
                    j += 1
            if j < len(tokens):
                results.append((tokens[j], tokens[j + 1:]))
            i = j + 1
        else:
            i += 1
    return results


def check(command: str):
    try:
        tokens = shlex.split(command)
    except ValueError:
        # Unbalanced quote (adversarial or malformed). Fall back to whitespace
        # tokenization rather than [] — an empty token list would disable every
        # token rule (sudo, chmod 777, git push/reset/branch). Approximate tokens
        # are strictly safer than none here.
        tokens = command.split()

    token_set = frozenset(tokens)

    CONFIG_READ_FLAGS = frozenset((
        "--get", "--get-all", "--get-regexp", "--get-urlmatch",
        "--list", "-l", "--show-origin", "--show-scope",
    ))

    for subcmd, args in get_git_invocations(tokens):
        # git config: allow reads, block writes
        if subcmd == "config":
            if not any(a in CONFIG_READ_FLAGS for a in args):
                deny("Blocked: git config writes persist and affect all future commits.")
            continue

        for rule_subcmd, required_args, message in GIT_RULES:
            if subcmd != rule_subcmd:
                continue
            if required_args is None or any(a in args for a in required_args):
                deny(message)

    for token, message in TOKEN_RULES:
        if token in token_set:
            deny(message)

    for token_a, token_b, message in TOKEN_PAIR_RULES:
        if token_a in token_set and token_b in token_set:
            deny(message)

    for pattern, message in REGEX_RULES:
        if pattern.search(command):
            deny(message)


def main():
    data = json.load(sys.stdin)
    command = data.get("tool_input", {}).get("command", "")
    if command:
        check(command)


if __name__ == "__main__":
    main()
