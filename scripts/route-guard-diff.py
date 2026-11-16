#!/usr/bin/env python3
"""Per-guard differential: each Bash guard script against its in-process port.

`route-dryrun.py` compares route's merged answer with the scripts' combined
answer on a sample. This harness goes wider and narrower: every unique Bash
command recorded under ~/.claude/projects, and each guard on its own, so a
difference in one guard cannot hide behind another guard's deny.

For each command it runs route twice on a hooks file listing only the guards
named in `route.builtins` of home/claude/route/hooks.json: once with the map
(the ports answer) and once without it (the scripts answer). route's log
line records each handler's stdout, which gives every guard's answer from
one run.

Each difference is classed by direction:

- stricter: the port denies, or refuses an allow, where the script did not;
- looser: the port lets through what the script denied, or allows what the
  script left to Claude Code;
- rewrite: quiet-override's rewrites differ.

Looser differences are the ones a go verdict must explain one by one.

Usage: scripts/route-guard-diff.py ROUTE_BIN [--files N] [--out DIR]
"""

import argparse
import collections
import concurrent.futures
import glob
import json
import os
import subprocess
import sys
import tempfile
import threading

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOOKS = os.path.join(ROOT, "home/claude/route/hooks.json")


def mine(files):
    seen = {}
    for path in files:
        try:
            fh = open(path, encoding="utf-8", errors="replace")
        except OSError:
            continue
        with fh:
            for line in fh:
                if '"tool_use"' not in line:
                    continue
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                content = (rec.get("message") or {}).get("content")
                if not isinstance(content, list):
                    continue
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "tool_use" and block.get("name") == "Bash":
                        cmd = (block.get("input") or {}).get("command")
                        if isinstance(cmd, str) and cmd not in seen:
                            seen[cmd] = rec.get("cwd") or ""
    return seen


def answer(stdout):
    out = (stdout or "").strip()
    if not out:
        return "none"
    try:
        hso = json.loads(out).get("hookSpecificOutput", {})
    except ValueError:
        return "invalid: " + out[:80]
    if "updatedInput" in hso:
        return "rewrite: " + str(hso["updatedInput"].get("command"))
    return hso.get("permissionDecision", "none")


def direction(guard, script, port):
    if guard == "quiet-override":
        return "rewrite"
    if guard == "pipe-allow":
        return "looser" if port == "allow" else "stricter"
    return "stricter" if port == "deny" else "looser"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("route")
    ap.add_argument("--files", type=int, default=0, help="most recent transcripts to mine (0: all)")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()
    route = os.path.abspath(args.route)
    out_dir = args.out or tempfile.mkdtemp(prefix="route-guard-diff-")
    os.makedirs(out_dir, exist_ok=True)

    builtins = json.load(open(HOOKS))["route"]["builtins"]
    group = {"matcher": "Bash", "hooks": [{"type": "command", "command": c} for c in builtins]}
    log = {"retention_days": 0, "max_input_chars": 10, "max_output_chars": 1000000}
    configs = {}
    for side, route_key in (("port", {"log": log, "builtins": builtins}), ("script", {"log": log})):
        path = os.path.join(out_dir, f"hooks-{side}.json")
        json.dump({"route": route_key, "hooks": {"PreToolUse": [group]}}, open(path, "w"))
        configs[side] = path
    state = os.path.join(out_dir, "state.json")
    json.dump({}, open(state, "w"))

    files = sorted(
        glob.glob(os.path.expanduser("~/.claude/projects/**/*.jsonl"), recursive=True),
        key=os.path.getmtime,
        reverse=True,
    )
    if args.files:
        files = files[: args.files]
    commands = mine(files)
    print(f"{len(commands)} unique Bash commands from {len(files)} transcripts", file=sys.stderr)

    local = threading.local()

    def answers(side, payload):
        if not hasattr(local, "dir"):
            local.dir = tempfile.mkdtemp(dir=out_dir, prefix="log-")
        log_dir = os.path.join(local.dir, side)
        subprocess.run(
            [route, "--config", configs[side], "--state", state, "--log-dir", log_dir, "PreToolUse"],
            input=payload,
            capture_output=True,
            cwd=out_dir,
            timeout=120,
        )
        day = sorted(os.listdir(log_dir))[-1]
        with open(os.path.join(log_dir, day), "rb") as f:
            last = f.read().splitlines()[-1]
        rec = json.loads(last)
        return {h["command"]: answer(h.get("stdout")) for h in rec["handlers"]}

    def check(item):
        cmd, cwd = item
        payload = json.dumps(
            {"session_id": "guard-diff", "cwd": cwd, "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": cmd}}
        ).encode()
        port, script = answers("port", payload), answers("script", payload)
        diffs = []
        for command, guard in builtins.items():
            p, s = port.get(command, "none"), script.get(command, "none")
            if p != s:
                diffs.append({"guard": guard, "script": s, "port": p, "direction": direction(guard, s, p)})
        return {"command": cmd, "cwd": cwd, "diffs": diffs}

    with concurrent.futures.ThreadPoolExecutor(8) as pool:
        results = list(pool.map(check, commands.items()))

    differing = [r for r in results if r["diffs"]]
    json.dump(differing, open(os.path.join(out_dir, "diffs.json"), "w"), indent=1, ensure_ascii=False)
    counts = collections.Counter()
    for r in differing:
        for d in r["diffs"]:
            counts[(d["guard"], d["direction"], d["script"][:40], d["port"][:40])] += 1
    print(f"{len(results)} commands; {len(results) - len(differing)} agree on every guard; {len(differing)} differ")
    print("| Guard | Direction | Script | Port | Commands |")
    print("| --- | --- | --- | --- | --- |")
    for (guard, d, s, p), n in sorted(counts.items(), key=lambda kv: (kv[0][0], kv[0][1], -kv[1])):
        if d == "rewrite":
            s, p = ("rewrite" if s.startswith("rewrite") else s), ("rewrite" if p.startswith("rewrite") else p)
        print(f"| {guard} | {d} | {s} | {p} | {n} |")
    print(f"Report: {os.path.join(out_dir, 'diffs.json')}")


if __name__ == "__main__":
    main()
