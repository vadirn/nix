#!/bin/bash
# Tests for rg-glob-guard.sh
SCRIPT="$(dirname "$0")/rg-glob-guard.sh"
PASS=0
FAIL=0

assert_deny() {
  local desc="$1" cmd="$2"
  result=$(jq -n --arg c "$cmd" '{tool_input:{command:$c}}' | bash "$SCRIPT")
  if echo "$result" | grep -q '"deny"'; then
    ((PASS++))
  else
    ((FAIL++))
    echo "FAIL (expected deny): $desc"
  fi
}

assert_allow() {
  local desc="$1" cmd="$2"
  result=$(jq -n --arg c "$cmd" '{tool_input:{command:$c}}' | bash "$SCRIPT")
  if [ -z "$result" ]; then
    ((PASS++))
  else
    ((FAIL++))
    echo "FAIL (expected allow): $desc"
  fi
}

# Should deny: negated glob, raw form (as written in tool_input)
assert_deny "single-quoted negation"      "rg --files . -g '!.git'"
assert_deny "negation with other flags"   "rg -l foo /path --hidden -g '!.git'"
assert_deny "--glob= form"                "rg foo --glob='!flake.nix' src"
assert_deny "double-quoted negation"      'rg foo -g "!*.lock" src'
assert_deny "bare negation"               'rg foo -g !target src'

# Should deny: harness-escaped form (! already rewritten to \!)
assert_deny "escaped single-quoted"       'rg --files . -g '\''\!.git'\'''
assert_deny "escaped bare"                'rg foo -g \!target src'

# Should deny: negation present even alongside a positive glob
# (the escaped ! turns the exclusion into a no-op, results are wrong)
assert_deny "mixed positive + negation"   "rg foo -g '*.md' -g '!README.md'"

# Should allow: no glob, positive globs, runtime-constructed negation
assert_allow "no glob"                    "rg foo src"
assert_allow "positive glob"              "rg foo -g '*.ts' src"
assert_allow "positive --glob= form"      "rg foo --glob='*.rs' src"
assert_allow "runtime-built negation"     'rg --files . -g "$(printf '\''\x21%s'\'' .lock)"'

# Should allow: -g on non-rg commands
assert_allow "git log -g"                 "git log -g --oneline"
assert_allow "no rg at all"               "echo hello"

echo "$((PASS + FAIL)) tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
