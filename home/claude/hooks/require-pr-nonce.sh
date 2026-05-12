#!/usr/bin/env bash
# PreToolUse hook: require a fresh /tmp/claude/pr-nonce.* before gh pr create.
# The /pr skill mints the nonce; manual gh pr create from a real terminal bypasses
# this hook entirely (hooks only fire inside Claude Code).
set -euo pipefail

INPUT=$(cat)
COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command')

# Pass through anything that is not a gh pr create invocation.
if ! printf '%s' "$COMMAND" | grep -Eq '(^|[[:space:];|&])gh[[:space:]]+pr[[:space:]]+create([[:space:]]|$)'; then
  exit 0
fi

deny() {
  jq -n --arg reason "$1" '{
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "deny",
      "permissionDecisionReason": $reason
    }
  }'
  exit 0
}

NONCE_DIR="/tmp/claude"
NONCE_PATTERN="${NONCE_DIR}/pr-nonce.*"

# Find the newest nonce file, if any.
NEWEST=""
for f in ${NONCE_PATTERN}; do
  # The glob literal is returned unchanged when no files match.
  [ -e "$f" ] || break
  if [ -z "$NEWEST" ] || [ "$f" -nt "$NEWEST" ]; then
    NEWEST="$f"
  fi
done

if [ -z "$NEWEST" ]; then
  deny "gh pr create blocked: no pr-nonce found. Run the /pr skill, which mints the nonce and creates the PR for you. For a manual terminal run, execute gh pr create outside Claude Code."
fi

# Check age: GNU stat (Nix coreutils) --format=%Y returns mtime as Unix epoch.
MTIME=$(stat --format=%Y "$NEWEST")
NOW=$(date +%s)
AGE=$(( NOW - MTIME ))

if [ "$AGE" -ge 60 ]; then
  deny "gh pr create blocked: pr-nonce is ${AGE}s old (limit 60s). Run the /pr skill to generate a fresh nonce, or run gh pr create from a normal terminal outside Claude Code."
fi

# Nonce is valid — consume all nonces and allow.
rm -f ${NONCE_PATTERN}
exit 0
