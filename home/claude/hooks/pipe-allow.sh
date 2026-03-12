#!/bin/bash
# pipe-allow.sh — PreToolUse hook for Claude Code
#
# Fixes prefix-matching limitations in Claude Code's permission system:
#
# 1. Pipes: `foo | tee /tmp/x` doesn't match Bash(tee:*)
# 2. Leading comments: `# comment\njq ...` doesn't match Bash(jq:*)
# 3. Env var prefixes: `CC=gcc make` doesn't match Bash(make:*)
# 4. Chained commands: `git add && git commit` doesn't match any single pattern
#
# Solution: Strip comments, env var assignments, and redirects, then split
# piped/chained commands into stages and check each against the allow list.
# If ALL stages match, auto-approve. Otherwise fall through to prompt.
#
# Security: env vars that affect code loading (PATH, LD_PRELOAD,
# LD_LIBRARY_PATH, DYLD_*, PYTHONPATH, etc.) always fall through to
# prompt — these can be used for injection/hijacking.
#
# Source: https://github.com/anthropics/claude-code/issues/29967

set -euo pipefail

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

if [ -z "$COMMAND" ]; then
  exit 0
fi

# Strip leading comment lines and blank lines
STRIPPED="$(echo "$COMMAND" | sed '/^[[:space:]]*#/d; /^[[:space:]]*$/d')"
COMMENTS_STRIPPED=false
if [ "$STRIPPED" != "$COMMAND" ]; then
  COMMENTS_STRIPPED=true
fi
COMMAND="$STRIPPED"

if [ -z "$COMMAND" ]; then
  exit 0
fi

SETTINGS="$HOME/.claude/settings.json"
if [ ! -f "$SETTINGS" ]; then
  exit 0
fi

# Extract allowed prefixes from Bash(prefix *) and Bash(prefix:*) patterns
ALLOWED_PREFIXES=()
while IFS= read -r line; do
  [ -n "$line" ] && ALLOWED_PREFIXES+=("$line")
done < <(
  jq -r '.permissions.allow[]? // empty' "$SETTINGS" |
  grep '^Bash(' |
  sed -n 's/^Bash(\(.*\))$/\1/p' |
  sed 's/:\*$//' |
  sed 's/ \*$//' |
  sort -u
)

if [ ${#ALLOWED_PREFIXES[@]} -eq 0 ]; then
  exit 0
fi

# Sensitive env vars — always require manual approval
SENSITIVE_VAR_PREFIXES=(
  "PATH=" "LD_" "DYLD_" "PYTHONPATH=" "PYTHONHOME="
  "NODE_PATH=" "GEM_PATH=" "GEM_HOME=" "RUBYLIB="
  "PERL5LIB=" "CLASSPATH=" "GOPATH="
)

is_sensitive_var() {
  local assignment="$1"
  for prefix in "${SENSITIVE_VAR_PREFIXES[@]}"; do
    if [[ "$assignment" == "$prefix"* ]]; then
      return 0
    fi
  done
  return 1
}

# Strip env var assignments and check underlying command against allow list
matches_allowed() {
  local cmd="$1"
  cmd="$(echo "$cmd" | sed 's/^[[:space:]]*//')"

  # Strip leading VAR=value assignments
  while [[ "$cmd" =~ ^([A-Za-z_][A-Za-z0-9_]*=) ]]; do
    local assignment="${cmd%%[[:space:]]*}"
    if is_sensitive_var "$assignment"; then
      return 1  # sensitive var — force prompt
    fi
    if [[ "$cmd" =~ ^[A-Za-z_][A-Za-z0-9_]*=\"[^\"]*\"[[:space:]]+(.*) ]]; then
      cmd="${BASH_REMATCH[1]}"
    elif [[ "$cmd" =~ ^[A-Za-z_][A-Za-z0-9_]*=\'[^\']*\'[[:space:]]+(.*) ]]; then
      cmd="${BASH_REMATCH[1]}"
    elif [[ "$cmd" =~ ^[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+(.*) ]]; then
      cmd="${BASH_REMATCH[1]}"
    else
      break
    fi
  done

  for prefix in "${ALLOWED_PREFIXES[@]}"; do
    if [[ "$cmd" == "$prefix"* ]]; then
      return 0
    fi
  done
  return 1
}

# Simple command with no transformations needed — let normal permissions handle it
has_env_prefix=false
first_line="$(echo "$COMMAND" | head -1 | sed 's/^[[:space:]]*//')"
if [[ "$first_line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
  has_env_prefix=true
fi

if [[ "$COMMENTS_STRIPPED" == false && "$has_env_prefix" == false && "$COMMAND" != *"|"* && "$COMMAND" != *"&&"* && "$COMMAND" != *";"* ]]; then
  exit 0
fi

# Split on pipes, &&, and ; to get individual command stages
STAGES=()
while IFS= read -r seg; do
  [ -n "$seg" ] && STAGES+=("$seg")
done < <(echo "$COMMAND" | sed 's/&&/\n/g; s/;/\n/g; s/|/\n/g')

all_match=true
for stage in "${STAGES[@]}"; do
  stage="$(echo "$stage" | sed '/^[[:space:]]*#/d; /^[[:space:]]*$/d' | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//')"
  clean="$(echo "$stage" | sed 's/[0-9]*>&[0-9]*//g' | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//')"
  [ -z "$clean" ] && continue
  if ! matches_allowed "$clean"; then
    all_match=false
    break
  fi
done

if [ "$all_match" = true ]; then
  jq -n '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: "All pipeline stages match allowed Bash prefixes"
    }
  }'
  exit 0
fi

exit 0
