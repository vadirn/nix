#!/usr/bin/env bash
# PostToolUse hook for Write and Edit: hand the agent the `autoformat` command
# for the file it just touched.
#
# Nothing is formatted here. A formatter that rewrites a file mid-turn breaks
# the next Edit to it — old_string no longer matches the reflowed content —
# which is what the old queue-format/flush-format-queue pair existed to dodge.
# Handing over the command instead dissolves the race: the agent formats when
# it is done editing, so no write lands behind its back.
#
# Stateless by construction. No queue, no marker file, nothing an interrupted
# or abandoned turn can leave behind. The hint repeats when the same file is
# edited twice; that is what holding no state costs.
#
# Silent unless the path carries an extension autoformat routes — the list is
# kept in sync with home/scripts/autoformat.ts's WEB_EXTS set plus its py and
# nix routing branches. Never blocks: exit 0 always.

set -uo pipefail

INPUT=$(cat)
# Newline-delimited so paths with spaces (e.g. the vault's "35 experiments/")
# survive.
{ IFS= read -r FILE; } < <(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // ""')

[ -n "$FILE" ] || exit 0
[ -f "$FILE" ] || exit 0

# vault-archive holds frozen, content-hash-addressed snapshots: formatting one
# diverges its bytes from the hash recorded on its reference stub.
case "$FILE" in
  "${HOME:-/nonexistent}/Documents/vault-archive/"*) exit 0 ;;
esac

case "${FILE##*.}" in
  ts | tsx | js | jsx | mjs | cjs | json | jsonc | md | html | css | py | nix) ;;
  *) exit 0 ;;
esac

jq -n --arg hint "Hint: \`autoformat '$FILE'\` formats this file — run it when you finish editing." '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: $hint
  }
}'
