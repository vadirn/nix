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

# curl/wget upload flags. The sandbox network allowlist checks where a request
# goes, never what it carries, so an upload to an already-allowlisted host (a
# GitHub gist, a completion endpoint) is the one exfiltration path it cannot
# see. These rules read the flags instead and fire whatever the destination.
CURL_UPLOAD_LONG = frozenset((
    "--data", "--data-ascii", "--data-binary", "--data-raw", "--data-urlencode",
    "--form", "--form-string", "--upload-file",
))
# Short upload flags, case-sensitive: -d data, -F form, -T upload. Lowercase -f
# (--fail) and -t (--telnet-option) have no upload effect and stay out, so
# `curl -f https://...` is not a false positive.
CURL_UPLOAD_SHORT = frozenset("dFT")
# Short options that swallow the rest of their token as a value. An upload
# letter after one of these is data, not a flag: `curl -oad.txt url` names an
# output file and posts nothing.
CURL_SHORT_TAKES_VALUE = frozenset("oHXuAebcCDEKmxyYzwUQPr")

WGET_UPLOAD_LONG = frozenset((
    "--post-data", "--post-file", "--body-data", "--body-file",
))

SEPARATORS = frozenset((";", "|", "||", "&&", "&"))

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


def _bare_name(token: str) -> str:
    """The command name at the end of a token, past any glued shell operator.

    `echo hi&&curl` tokenizes as one word; the invocation is still curl's.
    """
    return token.rsplit("&", 1)[-1].rsplit("|", 1)[-1].rsplit(";", 1)[-1]


def get_invocations(tokens: list[str], name: str) -> list[list[str]]:
    """Extract the argument list for each `name` invocation.

    Arguments run to the next separator token. A separator glued inside a later
    token (`curl url&&tar -T x`) is not split, so the following command's flags
    are read as this one's - a false positive, which is the safe direction.
    Residual: an obfuscated spelling or a name reached through a variable is not
    matched, the limit every token rule in this file carries.
    """
    results = []
    i = 0
    while i < len(tokens):
        if _bare_name(tokens[i]) == name:
            j = i + 1
            while j < len(tokens) and tokens[j] not in SEPARATORS:
                j += 1
            results.append(tokens[i + 1:j])
            i = j
        else:
            i += 1
    return results


def has_curl_upload_flag(args: list[str]) -> bool:
    """True when any argument is a curl flag that sends a body."""
    for arg in args:
        if arg.split("=", 1)[0] in CURL_UPLOAD_LONG:
            return True
        if arg.startswith("--") or not arg.startswith("-"):
            continue
        for char in arg[1:]:            # short-flag cluster, e.g. -sd@/etc/shadow
            if char in CURL_UPLOAD_SHORT:
                return True
            if char in CURL_SHORT_TAKES_VALUE:
                break                   # rest of the token is that option's value
    return False


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

    for args in get_invocations(tokens, "curl"):
        if has_curl_upload_flag(args):
            deny("Blocked: curl with data upload flags (-d/--data/-F/--form/-T). "
                 "The sandbox allowlist checks the destination, not the payload. "
                 "Run manually if needed.")

    for args in get_invocations(tokens, "wget"):
        if any(a.split("=", 1)[0] in WGET_UPLOAD_LONG for a in args):
            deny("Blocked: wget with --post-data/--post-file. Run manually if needed.")

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
