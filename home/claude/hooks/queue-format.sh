#!/usr/bin/env bash
# PostToolUse hook for Edit: defer formatting to the turn boundary.
#
# Formatting immediately after an Edit breaks the next Edit to the same file
# in the same turn (old_string no longer matches the reflowed content), so
# this hook only records the path. flush-format-queue.sh formats everything
# queued when the Stop hook fires.
#
# Queue: one path per line, per session, under TMPDIR so abandoned queues
# die with the OS temp cleanup. Never blocks: exit 0 always.

set -uo pipefail

INPUT=$(cat)
# Newline-delimited so paths with spaces (e.g. vault's "35 experiments/") survive.
{ IFS= read -r SID && IFS= read -r FILE; } < <(
  printf '%s' "$INPUT" | jq -r '.session_id // "default", (.tool_input.file_path // "")'
)

[ -n "$FILE" ] || exit 0

printf '%s\n' "$FILE" >>"${TMPDIR:-/tmp}/claude-format-queue-${SID}"
exit 0
