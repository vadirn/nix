#!/usr/bin/env python3
"""Run hooky's guard fixtures against the old guard scripts.

`hooky/tests/guards/*.json` hold the cases hooky's in-process guards must
pass inside `nix build .#hooky`: the cases each script's own test checked,
plus the cases where reading the shared parse changes the decision. For the
latter, `script` records what the old script answers and `why` says what
changed.

This harness checks the other side: every case's `script` answer (or its
`expect`, when the two agree) against the script itself, run as hooky's
hooks.json names it, from this checkout's `home/claude/hooks`. A case copied
wrongly from a script test, or a `script` answer that misstates the script,
fails here.

Usage: scripts/hooky-guard-fixtures.py
"""

import json
import os
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
HOOKS_DIR = ROOT / "home/claude/hooks"
FIXTURES = ROOT / "hooky/tests/guards"


def script_commands():
    builtins = json.loads((ROOT / "home/claude/hooky/hooks.json").read_text())["hooky"]["builtins"]
    return {name: cmd.replace("~/.claude/hooks/", f"{HOOKS_DIR}/") for cmd, name in builtins.items()}


def answer(stdout):
    out = stdout.strip()
    if not out:
        return "none"
    hso = json.loads(out).get("hookSpecificOutput", {})
    if "updatedInput" in hso:
        return {"rewrite": hso["updatedInput"].get("command")}
    return hso.get("permissionDecision", "none")


def main():
    commands = script_commands()
    failures, total = [], 0
    with tempfile.TemporaryDirectory() as home:
        for path in sorted(FIXTURES.glob("*.json")):
            doc = json.loads(path.read_text())
            guard = doc["guard"]
            env = dict(os.environ)
            if "settings_allow" in doc:
                os.makedirs(f"{home}/.claude", exist_ok=True)
                with open(f"{home}/.claude/settings.json", "w") as f:
                    json.dump({"permissions": {"allow": doc["settings_allow"]}}, f)
                env["HOME"] = home
            # `{root}` names the fixture's file tree; the scripts never read
            # it, so a fixed path stands in.
            fill = lambda s: s.replace("{root}", "/tmp/hooky-fixture-tree")
            for case in doc["cases"]:
                total += 1
                cwd = fill(case.get("cwd", doc.get("cwd", "")))
                payload = json.dumps({"tool_input": {"command": fill(case["command"])}, "cwd": cwd})
                p = subprocess.run(
                    ["bash", "-c", commands[guard]], input=payload, capture_output=True, text=True, env=env
                )
                want = case.get("script", case["expect"])
                got = answer(p.stdout)
                if got != want or p.stderr.strip():
                    failures.append(f"{guard}: {case['name']}: script gave {got!r}, fixture says {want!r} {p.stderr.strip()[:200]}")
    for f in failures:
        print(f)
    print(f"{total} cases, {total - len(failures)} match the scripts, {len(failures)} do not")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
