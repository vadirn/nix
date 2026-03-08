#!/usr/bin/env python3
import json, os, re, sys

input_data = json.load(sys.stdin)
command = input_data.get("tool_input", {}).get("command", "")
cwd = input_data.get("cwd", "")

if not re.search(r"(^|\s)rm\s+.*-[a-zA-Z]*r[a-zA-Z]*f|(^|\s)rm\s+.*-[a-zA-Z]*f[a-zA-Z]*r", command):
    sys.exit(0)

if not cwd:
    sys.exit(0)

# Extract paths: split into words, skip 'rm' and flags
words = command.split()
found_rm = False
paths = []
for word in words:
    if not found_rm:
        if word == "rm":
            found_rm = True
        continue
    if word.startswith("-"):
        continue
    paths.append(word)

cwd = os.path.normpath(cwd)

for p in paths:
    p = os.path.expanduser(p)
    if not os.path.isabs(p):
        p = os.path.join(cwd, p)
    p = os.path.normpath(p)

    # Trailing / prevents prefix collision (e.g. /nix vs /nix_evil)
    if not (p + "/").startswith(cwd + "/"):
        json.dump({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": f"rm -rf outside project directory is blocked. Target: {p}",
            }
        }, sys.stdout)
        sys.exit(0)
