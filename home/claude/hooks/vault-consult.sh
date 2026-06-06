#!/usr/bin/env bash
# UserPromptSubmit hook: inject relevant vault context before every user prompt.
# Reads the prompt from stdin JSON, runs `vault-query consult --ambient --format markdown`,
# and on exit 0 with non-empty output emits additionalContext via hookSpecificOutput.
# ALWAYS exits 0: a vault failure must never erase a prompt or print a hook-error line.
# Do NOT use set -e; every step is individually guarded.

# Read stdin (the hook JSON) into a variable. Suppress any read errors.
INPUT=$(cat 2>/dev/null) || INPUT=""

# Require jq to extract the prompt field.
if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

# Extract the prompt; empty string if field is absent.
PROMPT=$(printf '%s' "$INPUT" | jq -r '.prompt // empty' 2>/dev/null) || PROMPT=""

if [[ -z "$PROMPT" ]]; then
  exit 0
fi

# Resolve vault-query: prefer command-visible binary, then known nix profile paths.
VQ=""
if command -v vault-query >/dev/null 2>&1; then
  VQ=$(command -v vault-query)
elif [[ -x "$HOME/.nix-profile/bin/vault-query" ]]; then
  VQ="$HOME/.nix-profile/bin/vault-query"
elif [[ -x "/run/current-system/sw/bin/vault-query" ]]; then
  VQ="/run/current-system/sw/bin/vault-query"
fi

if [[ -z "$VQ" ]]; then
  exit 0
fi

# Run with a 10-second hard timeout so a pathological index rebuild cannot
# approach the 30s hook deadline. Capture stdout; check exit status.
RESULT=$(timeout 10 "$VQ" consult "$PROMPT" --ambient --format markdown 2>/dev/null)
STATUS=$?

# Exit 0 with non-empty output → inject as additionalContext.
# Any other status (4 = abstain, 1 = error, 124 = timeout) or empty output → emit nothing.
if [[ $STATUS -eq 0 && -n "$RESULT" ]]; then
  jq -n --arg ctx "$RESULT" \
    '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":$ctx}}'
fi

exit 0
