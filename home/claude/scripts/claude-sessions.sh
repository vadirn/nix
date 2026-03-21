#!/usr/bin/env bash
# Query live Claude Code sessions.
# Reads ~/.claude/sessions/*.json, filters to live PIDs.

set -euo pipefail

sessions_dir="$HOME/.claude/sessions"

if [[ ! -d "$sessions_dir" ]]; then
  echo "[]"
  exit 0
fi

live_files=()
for f in "$sessions_dir"/*.json; do
  [[ -f "$f" ]] || continue

  pid=$(jq -r '.pid // empty' "$f" 2>/dev/null) || continue
  [[ -z "$pid" ]] && continue

  kill -0 "$pid" 2>/dev/null || continue

  live_files+=("$f")
done

if [[ ${#live_files[@]} -eq 0 ]]; then
  echo "[]"
else
  jq -s '.' "${live_files[@]}"
fi
