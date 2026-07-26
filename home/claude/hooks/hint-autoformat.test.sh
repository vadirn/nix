#!/bin/bash
# Tests for hint-autoformat.sh — the PostToolUse hook that names `autoformat`
# for the file Write/Edit just touched. Requires jq.
HOOKS="$(cd "$(dirname "$0")" && pwd)"
PASS=0
FAIL=0

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

hint() {
  jq -n --arg f "$1" '{tool_name: "Edit", tool_input: {file_path: $f}}' \
    | bash "$HOOKS/hint-autoformat.sh"
}

check() {
  local desc="$1" cond="$2"
  if eval "$cond"; then
    ((PASS++))
  else
    ((FAIL++))
    echo "FAIL: $desc"
  fi
}

# A routed extension produces additionalContext naming the path
touch "$WORK/a.ts"
OUT=$(hint "$WORK/a.ts")
check "emits PostToolUse hookSpecificOutput" \
  '[ "$(printf %s "$OUT" | jq -r .hookSpecificOutput.hookEventName)" = PostToolUse ]'
HINT=$(printf %s "$OUT" | jq -r .hookSpecificOutput.additionalContext)
check "hint names the autoformat command" 'grep -qF "autoformat" <<<"$HINT"'
check "hint quotes the edited path" 'grep -qF "'\''$WORK/a.ts'\''" <<<"$HINT"'

# Paths with spaces survive intact
SPACED="$WORK/dir with space"
mkdir -p "$SPACED"
touch "$SPACED/note.md"
check "path with spaces survives" \
  'hint "$SPACED/note.md" | jq -r .hookSpecificOutput.additionalContext | grep -qF "$SPACED/note.md"'

# Extensions autoformat does not route stay silent
touch "$WORK/notes.txt"
check "unrouted extension emits nothing" '[ -z "$(hint "$WORK/notes.txt")" ]'
touch "$WORK/Makefile"
check "extensionless file emits nothing" '[ -z "$(hint "$WORK/Makefile")" ]'

# Missing or absent paths stay silent
check "missing file_path emits nothing" \
  '[ -z "$(printf "{\"tool_input\":{}}" | bash "$HOOKS/hint-autoformat.sh")" ]'
check "nonexistent file emits nothing" '[ -z "$(hint "$WORK/gone.ts")" ]'

# vault-archive snapshots are frozen: never hint at reformatting one
mkdir -p "$WORK/Documents/vault-archive"
touch "$WORK/Documents/vault-archive/frozen.md"
check "vault-archive emits nothing" \
  '[ -z "$(HOME="$WORK" hint "$WORK/Documents/vault-archive/frozen.md")" ]'

# The hook never blocks
hint "$WORK/a.ts" >/dev/null
check "exits 0" '[ $? -eq 0 ]'

echo "$((PASS + FAIL)) tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
