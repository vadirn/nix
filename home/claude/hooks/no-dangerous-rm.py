#!/usr/bin/env python3
"""PreToolUse hook: block recursive `rm` whose target is outside the project.

Fail-safe posture: this hook gates a real shell, so it cannot always resolve the
true target. When it can't (unexpanded `$VAR` in a path, or a `cd` earlier in the
chain that moves the effective cwd), it denies rather than guessing. It triggers
on any recursive delete (`-r`/`-R`/`--recursive`, bundled or split); in-project
recursive deletes still pass the path check, so `rm -rf node_modules` is fine.
"""
import json, os, re, shlex, sys

input_data = json.load(sys.stdin)
command = input_data.get("tool_input", {}).get("command", "")
cwd = input_data.get("cwd", "")

if not cwd:
    sys.exit(0)

cwd_norm = os.path.normpath(cwd)


def deny(reason):
    json.dump({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }, sys.stdout)
    sys.exit(0)


def tokenize(segment):
    """shlex (strips quotes, respects them) with a whitespace fallback on the
    adversarial unbalanced-quote case."""
    try:
        return shlex.split(segment)
    except ValueError:
        return segment.split()


def strip_quotes(token):
    if len(token) >= 2 and token[0] == token[-1] and token[0] in ("'", '"'):
        return token[1:-1]
    return token


def check_rm(segment, seen_cd):
    toks = tokenize(segment)
    if "rm" not in toks:
        return
    args = toks[toks.index("rm") + 1:]

    flags, paths, end_opts = [], [], False
    for t in args:
        if not end_opts and t == "--":
            end_opts = True
            continue
        if not end_opts and len(t) > 1 and t.startswith("-"):
            flags.append(t)
        else:
            paths.append(t)

    # Recursive = --recursive, or a short-flag cluster containing r/R (-r, -rf,
    # -Rf, -fr). rm has no non-recursive short flag with r/R, so this is exact.
    recursive = any(
        f == "--recursive" or (not f.startswith("--") and re.search(r"[rR]", f))
        for f in flags
    )
    if not recursive:
        return

    # Fail-safe: a `cd` earlier in the chain moved the cwd we were handed.
    if seen_cd:
        deny("Blocked: recursive rm after a `cd` — the effective directory can't "
             "be verified. Run it manually if intended.")

    for p in paths:
        p = strip_quotes(p)
        # Fail-safe: unexpanded variable — target is unknowable at hook time.
        if "$" in p:
            deny(f"Blocked: recursive rm with an unexpanded variable in the path "
                 f"({p}). Target can't be verified; run it manually if intended.")
        ep = os.path.expanduser(p)
        if not os.path.isabs(ep):
            ep = os.path.join(cwd_norm, ep)
        ep = os.path.normpath(ep)
        # Trailing / prevents prefix collision (e.g. /nix vs /nix_evil).
        if not (ep + "/").startswith(cwd_norm + "/"):
            deny(f"rm -rf outside project directory is blocked. Target: {ep}")


# Split the chain into ordered segments so we can spot a `cd` that runs before
# an `rm`. `&&`/`||` are matched before the single-char separators `;`/`|`/`&`.
segments = re.split(r"&&|\|\||[;|&]", command)

seen_cd = False
for seg in segments:
    raw = seg.split()
    if not raw:
        continue
    if raw[0] == "cd":
        seen_cd = True
    if "rm" in raw:
        check_rm(seg, seen_cd)
