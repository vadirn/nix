#!/bin/bash
# Tests for queue-format.sh + flush-format-queue.sh (and the path-argument
# entry point of post-tool-format.sh they rely on). Requires oxfmt.
HOOKS="$(cd "$(dirname "$0")" && pwd)"
PASS=0
FAIL=0

# Isolate queues from real sessions: hooks key the queue path off TMPDIR.
export TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

SID="testsess"
QUEUE="$TMPDIR/claude-format-queue-$SID"

queue() {
  jq -n --arg s "$SID" --arg f "$1" \
    '{session_id: $s, tool_input: {file_path: $f}}' | bash "$HOOKS/queue-format.sh"
}

flush() {
  jq -n --arg s "$SID" '{session_id: $s}' | bash "$HOOKS/flush-format-queue.sh"
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

# Queue records the path, spaces intact
SCRATCH="$TMPDIR/dir with space"
mkdir -p "$SCRATCH"
printf '{   "a":1,"b":   [2,3]}' >"$SCRATCH/bad.json"
queue "$SCRATCH/bad.json"
check "queue file created" '[ -f "$QUEUE" ]'
check "queued path survives spaces" 'grep -qF "$SCRATCH/bad.json" "$QUEUE"'

# Missing file_path queues nothing
rm -f "$QUEUE"
printf '{"session_id":"%s","tool_input":{}}' "$SID" | bash "$HOOKS/queue-format.sh"
check "empty file_path skipped" '[ ! -f "$QUEUE" ]'

# Flush with no queue is a clean no-op
flush
check "flush without queue exits 0" '[ $? -eq 0 ]'

# Flush formats the queued file and consumes the queue
ORIG=$(cat "$SCRATCH/bad.json")
queue "$SCRATCH/bad.json"
queue "$SCRATCH/bad.json"
flush
check "flush reformats file" '[ "$(cat "$SCRATCH/bad.json")" != "$ORIG" ]'
check "flush leaves valid json" 'jq empty "$SCRATCH/bad.json" 2>/dev/null'
check "flush consumes queue" '[ ! -f "$QUEUE" ]'

# Queued-then-deleted file does not break the flush
queue "$SCRATCH/gone.json"
flush
check "flush tolerates deleted file" '[ $? -eq 0 ]'
check "flush consumes queue after deletion" '[ ! -f "$QUEUE" ]'

# Regression: post-tool-format.sh stdin mode (Write path) still works
printf '{   "c":4}' >"$SCRATCH/write.json"
jq -n --arg f "$SCRATCH/write.json" '{tool_input: {file_path: $f}}' \
  | bash "$HOOKS/post-tool-format.sh"
check "stdin entry point still formats" '[ "$(cat "$SCRATCH/write.json")" != "{   \"c\":4}" ]'

echo "$((PASS + FAIL)) tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
