#!/usr/bin/env bash
# Runtime and global policy locations belong to user configuration.
set -uo pipefail

global_config="${TRINKET_TURN_CONFIG:-$HOME/.config/trinket/turn-check.json}"
project_config="${CLAUDE_PROJECT_DIR:-}/.claude/turn-check.json"
if [ -f "$global_config" ]; then
  mode=--global
  config="$global_config"
elif [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -f "$project_config" ]; then
  mode=--config
  config="$project_config"
else
  cat >/dev/null
  exit 0
fi

adapter="${TRINKET_CLAUDE_ADAPTER:-$HOME/.local/bin/trinket-claude-stop}"
if [ ! -x "$adapter" ]; then
  cat >/dev/null
  echo "turn-check: installed adapter is unavailable; stopping is permitted." >&2
  exit 0
fi

# Never fall back to an independent blocking verifier after an adapter failure.
exec "$adapter" "$mode" "$config"
