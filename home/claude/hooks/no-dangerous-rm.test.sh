#!/bin/bash
# Tests for no-dangerous-rm.py
SCRIPT="$(dirname "$0")/no-dangerous-rm.py"
PASS=0
FAIL=0

assert_deny() {
  local desc="$1" input="$2"
  result=$(echo "$input" | python3 "$SCRIPT")
  if echo "$result" | grep -q '"deny"'; then
    ((PASS++))
  else
    ((FAIL++))
    echo "FAIL (expected deny): $desc"
  fi
}

assert_allow() {
  local desc="$1" input="$2"
  result=$(echo "$input" | python3 "$SCRIPT")
  if [ -z "$result" ]; then
    ((PASS++))
  else
    ((FAIL++))
    echo "FAIL (expected allow): $desc"
  fi
}

CWD="/Users/vadim/nix"

# Should deny
assert_deny  "rm -rf outside project" \
  '{"tool_input":{"command":"rm -rf /tmp/something"},"cwd":"'"$CWD"'"}'

assert_deny  "rm -fr outside project" \
  '{"tool_input":{"command":"rm -fr /etc/something"},"cwd":"'"$CWD"'"}'

assert_deny  "rm -rf ~ path outside project" \
  '{"tool_input":{"command":"rm -rf ~/Documents"},"cwd":"'"$CWD"'"}'

assert_deny  "rm -rf root" \
  '{"tool_input":{"command":"rm -rf /"},"cwd":"'"$CWD"'"}'

assert_deny  "rm -rf path traversal with .." \
  '{"tool_input":{"command":"rm -rf ../../etc"},"cwd":"'"$CWD"'"}'

assert_deny  "rm -rf sibling dir with shared prefix" \
  '{"tool_input":{"command":"rm -rf /Users/vadim/nix_evil"},"cwd":"'"$CWD"'"}'

# Should allow
assert_allow "rm -rf inside project (absolute)" \
  '{"tool_input":{"command":"rm -rf /Users/vadim/nix/dist"},"cwd":"'"$CWD"'"}'

assert_allow "rm -rf inside project (relative)" \
  '{"tool_input":{"command":"rm -rf dist node_modules"},"cwd":"'"$CWD"'"}'

assert_allow "plain rm (no -rf)" \
  '{"tool_input":{"command":"rm file.txt"},"cwd":"'"$CWD"'"}'

assert_allow "rm -r without -f" \
  '{"tool_input":{"command":"rm -r somedir"},"cwd":"'"$CWD"'"}'

assert_allow "non-rm command" \
  '{"tool_input":{"command":"ls -la /tmp"},"cwd":"'"$CWD"'"}'

# --- Bypasses closed by the rewrite ---
assert_deny  "rm -Rf uppercase outside project" \
  '{"tool_input":{"command":"rm -Rf /Users/vadim/Documents"},"cwd":"'"$CWD"'"}'

assert_deny  "rm -r -f split flags outside project" \
  '{"tool_input":{"command":"rm -r -f /Users/vadim/Documents"},"cwd":"'"$CWD"'"}'

assert_deny  "rm -rf quoted path outside project" \
  '{"tool_input":{"command":"rm -rf \"/Users/vadim/Documents\""},"cwd":"'"$CWD"'"}'

assert_deny  "rm --recursive long flag outside project" \
  '{"tool_input":{"command":"rm --recursive --force /Users/vadim/Documents"},"cwd":"'"$CWD"'"}'

assert_deny  "rm -rf unexpanded var" \
  '{"tool_input":{"command":"rm -rf $HOME"},"cwd":"'"$CWD"'"}'

assert_deny  "cd then rm -rf trusts wrong cwd" \
  '{"tool_input":{"command":"cd / && rm -rf etc"},"cwd":"'"$CWD"'"}'

assert_deny  "rm -rf -- outside project" \
  '{"tool_input":{"command":"rm -rf -- /Users/vadim/Documents"},"cwd":"'"$CWD"'"}'

# --- Ordinary recursive deletes stay allowed ---
assert_allow "rm -rf inside project (build)" \
  '{"tool_input":{"command":"rm -rf /Users/vadim/nix/build"},"cwd":"'"$CWD"'"}'

assert_allow "rm -rf node_modules then npm i" \
  '{"tool_input":{"command":"rm -rf node_modules && npm i"},"cwd":"'"$CWD"'"}'

echo "$((PASS + FAIL)) tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
