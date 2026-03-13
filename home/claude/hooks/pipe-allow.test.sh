#!/bin/bash
# Tests for pipe-allow.py
SCRIPT="$(dirname "$0")/pipe-allow.py"
PASS=0
FAIL=0

# Create temp settings with known allowed prefixes
SETTINGS_DIR=$(mktemp -d)
mkdir -p "$SETTINGS_DIR/.claude"
cat > "$SETTINGS_DIR/.claude/settings.json" << 'EOF'
{
  "permissions": {
    "allow": [
      "Bash(cat *)",
      "Bash(jq *)",
      "Bash(git status *)",
      "Bash(git log *)",
      "Bash(git add *)",
      "Bash(git commit *)",
      "Bash(head *)",
      "Bash(echo *)",
      "Bash(wc *)",
      "Bash(grep *)",
      "Bash(ls *)"
    ]
  }
}
EOF

run_hook() {
  local cmd="$1"
  printf '{"tool_input":{"command":%s}}' "$(printf '%s' "$cmd" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" \
    | HOME="$SETTINGS_DIR" python3 "$SCRIPT"
}

assert_allow() {
  local desc="$1" cmd="$2"
  result=$(run_hook "$cmd")
  decision=$(echo "$result" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("hookSpecificOutput",{}).get("permissionDecision",""))' 2>/dev/null)
  if [ "$decision" = "allow" ]; then
    ((PASS++))
  else
    ((FAIL++))
    echo "FAIL (expected allow): $desc"
    echo "  command: $cmd"
    echo "  output:  $result"
  fi
}

assert_passthrough() {
  local desc="$1" cmd="$2"
  result=$(run_hook "$cmd")
  if [ -z "$result" ]; then
    ((PASS++))
  else
    ((FAIL++))
    echo "FAIL (expected passthrough): $desc"
    echo "  command: $cmd"
    echo "  output:  $result"
  fi
}

# --- Simple pipes (should allow) ---
assert_allow    "cat | jq"              "cat file.json | jq ."
assert_allow    "cat | head"            "cat file.txt | head -20"
assert_allow    "echo | wc"             "echo hello | wc -l"
assert_allow    "git log | grep"        "git log --oneline | grep fix"

# --- Chained commands (should allow) ---
assert_allow    "git add && git commit" "git add -A && git commit -m test"

# --- Quote-aware: pipes inside jq expressions ---
assert_allow    "jq with pipe in single quotes" \
  "cat data.json | jq -r '.data.web[] | \"\(.title): \(.url)\"'"
assert_allow    "jq with pipe in double quotes" \
  'cat data.json | jq -r ".items[] | .name"'
assert_allow    "jq multiple pipes in expression" \
  "cat data.json | jq '.[] | .name | ascii_downcase'"
assert_allow    "jq select with pipe" \
  "cat data.json | jq '.[] | select(.age > 30) | .name'"

# --- Simple commands (no pipe/chain — passthrough to normal perms) ---
assert_passthrough "simple cat"         "cat file.txt"
assert_passthrough "simple jq"          "jq . file.json"
assert_passthrough "simple ls"          "ls -la"

# --- Unknown commands in pipe (should passthrough) ---
assert_passthrough "pipe with unknown"  "cat file.txt | python3 script.py"
assert_passthrough "unknown first"      "curl url | jq ."

# --- Comments stripped (should allow if underlying stages match) ---
assert_allow    "comment then pipe"     "# list files
cat file.json | jq ."

# --- Semicolons inside quotes (should treat as one stage) ---
assert_allow    "semicolon in quotes"   "echo 'hello; world' | wc -l"

# --- Env var prefix (should allow if var is not sensitive) ---
assert_allow    "safe env var"          "FOO=bar cat file.json | jq ."
assert_passthrough "sensitive PATH"     "PATH=/evil cat file.json | jq ."
assert_passthrough "sensitive LD_PRELOAD" "LD_PRELOAD=x.so cat file.json | jq ."

# Cleanup
rm -rf "$SETTINGS_DIR"

echo "$((PASS + FAIL)) tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
