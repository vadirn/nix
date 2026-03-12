#!/bin/bash
# Tests for no-dangerous.sh
SCRIPT="$(dirname "$0")/no-dangerous.sh"
PASS=0
FAIL=0

assert_deny() {
  local desc="$1" cmd="$2"
  result=$(echo '{"tool_input":{"command":"'"$cmd"'"}}' | bash "$SCRIPT")
  if echo "$result" | grep -q '"deny"'; then
    ((PASS++))
  else
    ((FAIL++))
    echo "FAIL (expected deny): $desc"
  fi
}

assert_allow() {
  local desc="$1" cmd="$2"
  result=$(echo '{"tool_input":{"command":"'"$cmd"'"}}' | bash "$SCRIPT")
  if [ -z "$result" ]; then
    ((PASS++))
  else
    ((FAIL++))
    echo "FAIL (expected allow): $desc"
  fi
}

# sudo
assert_deny  "sudo command"              "sudo apt install foo"
assert_deny  "sudo after semicolon"      "echo hi; sudo reboot"
assert_allow "no sudo"                   "echo hello"

# chmod 777
assert_deny  "chmod 777"                 "chmod 777 /tmp/foo"
assert_allow "chmod 755"                 "chmod 755 /tmp/foo"
assert_allow "chmod 700"                 "chmod 700 dir"

# git push --force / -f
assert_deny  "git push --force"          "git push --force"
assert_deny  "git push -f"              "git push origin main -f"
assert_deny  "git push --force-with-lease is not --force" "git push --force"
assert_allow "git push"                  "git push origin main"
assert_allow "git push upstream"         "git push upstream feature"

# git reset --hard
assert_deny  "git reset --hard"          "git reset --hard HEAD~1"
assert_deny  "git reset --hard no ref"   "git reset --hard"
assert_allow "git reset soft"            "git reset HEAD~1"
assert_allow "git reset --soft"          "git reset --soft HEAD~1"

# git branch -D
assert_deny  "git branch -D"            "git branch -D main"
assert_deny  "git branch -D end"        "git branch -D"
assert_allow "git branch -d"            "git branch -d main"
assert_allow "git branch list"           "git branch --list"

# git -C (absorbed from no-git-c.sh)
assert_deny  "git -C path"              "git -C /tmp status"
assert_deny  "git -C relative"          "git -C ../other log"
assert_allow "git status"               "git status"
assert_allow "git log"                  "git log --oneline"

# obsidian dangerous subcommands
assert_deny  "obsidian eval"             "obsidian eval"
assert_deny  "obsidian eval with args"   "obsidian eval some-code"
assert_deny  "obsidian plugin:install"   "obsidian plugin:install foo"
assert_deny  "obsidian plugin:uninstall" "obsidian plugin:uninstall foo"
assert_deny  "obsidian dev:cdp"          "obsidian dev:cdp"
assert_deny  "obsidian command"          "obsidian command foo"
assert_deny  "obsidian command no arg"   "obsidian command"
assert_deny  "obsidian history:restore"  "obsidian history:restore"
assert_allow "obsidian search"           "obsidian search foo"
assert_allow "obsidian list"             "obsidian list"
assert_allow "obsidian read"             "obsidian read note.md"

echo "$((PASS + FAIL)) tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
