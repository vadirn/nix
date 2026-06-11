#!/usr/bin/env bash
# Stop hook: format every file Edit touched this turn.
#
# Companion to queue-format.sh (see its header for why Edits defer). Reads
# the per-session queue, dedups, and routes each path through
# post-tool-format.sh's formatter dispatch via its path-argument entry point.
# Runs before stop-verify.sh in settings.json so verification sees formatted
# files. Never blocks: exit 0 always.

set -uo pipefail

INPUT=$(cat)
{ IFS= read -r SID; } < <(printf '%s' "$INPUT" | jq -r '.session_id // "default"')

QUEUE="${TMPDIR:-/tmp}/claude-format-queue-${SID}"
[ -f "$QUEUE" ] || exit 0

# Take ownership before formatting so a concurrent append lands in a fresh
# queue instead of being lost mid-flush.
WORK="${QUEUE}.flush.$$"
mv "$QUEUE" "$WORK" 2>/dev/null || exit 0

while IFS= read -r FILE; do
  [ -n "$FILE" ] || continue
  [ -f "$FILE" ] || continue
  bash "$(dirname "$0")/post-tool-format.sh" "$FILE" || true
done < <(sort -u "$WORK")

rm -f "$WORK"
exit 0
