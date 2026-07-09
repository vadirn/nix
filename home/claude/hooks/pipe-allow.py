#!/usr/bin/env python3
"""PreToolUse hook: auto-approve piped/chained Bash commands.

Fixes prefix-matching limitations in Claude Code's permission system:

1. Pipes: `foo | tee /tmp/x` doesn't match Bash(tee:*)
2. Leading comments: `# comment\njq ...` doesn't match Bash(jq:*)
3. Env var prefixes: `CC=gcc make` doesn't match Bash(make:*)
4. Chained commands: `git add && git commit` doesn't match any single pattern

Solution: strip comments, env var assignments, and redirects, then split
piped/chained commands into stages (respecting shell quoting) and check
each against the allow list. If ALL stages match, auto-approve.

Security: env vars that affect code loading (PATH, LD_PRELOAD,
LD_LIBRARY_PATH, DYLD_*, PYTHONPATH, etc.) always fall through to
prompt — these can be used for injection/hijacking.

Source: https://github.com/anthropics/claude-code/issues/29967
"""

import json, os, re, shlex, sys

SETTINGS_PATH = os.path.expanduser("~/.claude/settings.json")

SENSITIVE_VAR_PREFIXES = (
    "PATH=", "LD_", "DYLD_", "PYTHONPATH=", "PYTHONHOME=",
    "NODE_PATH=", "GEM_PATH=", "GEM_HOME=", "RUBYLIB=",
    "PERL5LIB=", "CLASSPATH=", "GOPATH=",
)


def load_allowed_prefixes():
    """Extract allowed Bash prefixes from settings.json."""
    if not os.path.isfile(SETTINGS_PATH):
        return []
    with open(SETTINGS_PATH) as f:
        settings = json.load(f)
    allow = settings.get("permissions", {}).get("allow", [])
    prefixes = set()
    for entry in allow:
        m = re.match(r"^Bash\((.+)\)$", entry)
        if not m:
            continue
        prefix = m.group(1)
        prefix = re.sub(r"[: ]\*$", "", prefix)
        prefixes.add(prefix)
    return sorted(prefixes)


def split_command(cmd):
    """Split command on |, &&, ; respecting shell quoting."""
    stages = []
    current = []
    i = 0
    length = len(cmd)
    quote = None
    while i < length:
        ch = cmd[i]
        if quote:
            current.append(ch)
            if ch == quote:
                quote = None
        elif ch in ("'", '"'):
            quote = ch
            current.append(ch)
        elif ch == "|":
            stages.append("".join(current))
            current = []
        elif ch == ";":
            stages.append("".join(current))
            current = []
        elif ch == "&":
            # Lone `&` is a background operator (also a stage separator);
            # `&&` is a chain operator. Split on both, consuming the second `&`.
            stages.append("".join(current))
            current = []
            if i + 1 < length and cmd[i + 1] == "&":
                i += 1
        else:
            current.append(ch)
        i += 1
    if current:
        stages.append("".join(current))
    return [s for s in stages if s.strip()]


def strip_env_vars(cmd):
    """Strip leading VAR=value assignments. Return None if sensitive var found."""
    env_re = re.compile(
        r'^([A-Za-z_]\w*)='
        r'(?:"[^"]*"|\'[^\']*\'|\S*)'
        r'\s+'
    )
    while True:
        m = env_re.match(cmd)
        if not m:
            break
        var_name = m.group(1)
        assignment = cmd[:m.end()].strip()
        if any(assignment.startswith(p) for p in SENSITIVE_VAR_PREFIXES):
            return None
        cmd = cmd[m.end():]
    return cmd


def strip_quoted(cmd):
    """Remove single/double quoted spans so shell metacharacters inside
    arguments (e.g. a jq expression like '.age > 30') aren't mistaken for
    shell operators when scanning for unmodelable constructs."""
    out = []
    quote = None
    for ch in cmd:
        if quote:
            if ch == quote:
                quote = None
        elif ch in ("'", '"'):
            quote = ch
        else:
            out.append(ch)
    return "".join(out)


def matches_allowed(cmd, prefixes):
    """Check if a single command stage matches any allowed prefix."""
    cmd = cmd.strip()
    cmd = strip_env_vars(cmd)
    if cmd is None:
        return False
    cmd = re.sub(r"\d*>&\d*", "", cmd).strip()
    # Fail-safe: refuse to grant if a stage still holds a construct this hook
    # cannot model (command substitution, or a redirect that could smuggle a
    # second command). Scan only OUTSIDE quotes so quoted jq expressions don't
    # trip it. Refusing only means the command falls through to the normal
    # prompt/classifier — pipe-allow never denies, so this is always safe.
    if any(t in strip_quoted(cmd) for t in ("`", "$(", ">", "<")):
        return False
    return any(cmd.startswith(p) for p in prefixes)


def strip_comments(command):
    """Remove comment lines and blank lines."""
    lines = command.split("\n")
    stripped = [l for l in lines if not re.match(r"^\s*#", l) and l.strip()]
    return "\n".join(stripped)


def main():
    input_data = json.load(sys.stdin)
    command = input_data.get("tool_input", {}).get("command", "")
    if not command:
        return

    original = command
    command = strip_comments(command)
    comments_stripped = (command != original)
    if not command:
        return

    prefixes = load_allowed_prefixes()
    if not prefixes:
        return

    # Simple command with no transformations — let normal permissions handle it
    has_env_prefix = bool(re.match(r"^[A-Za-z_]\w*=", command.split("\n")[0].lstrip()))
    if not comments_stripped and not has_env_prefix:
        if "|" not in command and "&&" not in command and ";" not in command:
            return

    stages = split_command(command)
    if all(matches_allowed(stage, prefixes) for stage in stages):
        json.dump({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
                "permissionDecisionReason":
                    "All pipeline stages match allowed Bash prefixes",
            }
        }, sys.stdout)


if __name__ == "__main__":
    main()
