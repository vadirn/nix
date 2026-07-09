#!/usr/bin/env python3
"""Tests for no-dangerous.py"""
import json
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).parent / "no-dangerous.py"
PASS = 0
FAIL = 0


def run(command: str) -> str:
    payload = json.dumps({"tool_input": {"command": command}})
    result = subprocess.run(
        [sys.executable, str(SCRIPT)],
        input=payload, capture_output=True, text=True,
    )
    return result.stdout


def assert_deny(desc: str, cmd: str):
    global PASS, FAIL
    out = run(cmd)
    if '"deny"' in out:
        PASS += 1
    else:
        FAIL += 1
        print(f"FAIL (expected deny): {desc}")


def assert_allow(desc: str, cmd: str):
    global PASS, FAIL
    out = run(cmd)
    if out.strip() == "":
        PASS += 1
    else:
        FAIL += 1
        print(f"FAIL (expected allow): {desc}")


# sudo
assert_deny("sudo command", "sudo apt install foo")
assert_deny("sudo after semicolon", "echo hi; sudo reboot")
assert_allow("no sudo", "echo hello")

# chmod 777
assert_deny("chmod 777", "chmod 777 /tmp/foo")
assert_allow("chmod 755", "chmod 755 /tmp/foo")
assert_allow("chmod 700", "chmod 700 dir")

# git push
assert_deny("git push", "git push origin main")
assert_deny("git push no args", "git push")
assert_deny("git push --force", "git push --force")
assert_deny("git push -f", "git push origin main -f")
assert_allow("git push in commit msg", "git commit -m 'block git push in hook'")

# git reset --hard
assert_deny("git reset --hard", "git reset --hard HEAD~1")
assert_deny("git reset --hard no ref", "git reset --hard")
assert_allow("git reset soft", "git reset HEAD~1")
assert_allow("git reset --soft", "git reset --soft HEAD~1")
assert_allow("reset --hard in msg", "git commit -m 'avoid git reset --hard'")

# git branch -D
assert_deny("git branch -D", "git branch -D main")
assert_deny("git branch -D end", "git branch -D")
assert_allow("git branch -d", "git branch -d main")
assert_allow("git branch list", "git branch --list")

# git config writes (blocked)
assert_deny("git config user", "git config user.name foo")
assert_deny("git config --global", "git config --global user.email x")
assert_allow("git config in msg", "git commit -m 'fix git config issue'")

# git config reads (allowed)
assert_allow("git config --get", "git config --get user.name")
assert_allow("git config --list", "git config --list")
assert_allow("git config -l", "git config -l")
assert_allow("git config --get-regexp", "git config --get-regexp sign")

# git -C
assert_deny("git -C path", "git -C /tmp status")
assert_deny("git -C relative", "git -C ../other log")
assert_allow("git status", "git status")
assert_allow("git log", "git log --oneline")

# obsidian
assert_deny("obsidian eval", "obsidian eval")
assert_deny("obsidian eval with args", "obsidian eval some-code")
assert_deny("obsidian plugin:install", "obsidian plugin:install foo")
assert_deny("obsidian plugin:uninstall", "obsidian plugin:uninstall foo")
assert_deny("obsidian dev:cdp", "obsidian dev:cdp")
assert_deny("obsidian command", "obsidian command foo")
assert_deny("obsidian command no arg", "obsidian command")
assert_deny("obsidian history:restore", "obsidian history:restore")
assert_allow("obsidian search", "obsidian search foo")
assert_allow("obsidian list", "obsidian list")
assert_allow("obsidian read", "obsidian read note.md")

# unbalanced quote must not disable token rules (fail-safe fallback)
assert_deny("sudo with trailing unbalanced quote", "sudo reboot #'")
assert_deny("git push with trailing unbalanced quote", "git push origin main #'")

# heredoc commit message (the original bug)
assert_allow("git push in heredoc commit",
             "git commit -m \"$(cat <<'EOF'\nchore: block git push in hook\nEOF\n)\"")

total = PASS + FAIL
print(f"{total} tests: {PASS} passed, {FAIL} failed")
sys.exit(0 if FAIL == 0 else 1)
