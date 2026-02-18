#!/usr/bin/env bash
set -euo pipefail

SOUNDS_DIR="$HOME/.claude/hooks/sounds"

case "${1:-}" in
  SessionStart)     dir="$SOUNDS_DIR/start" ;;
  UserPromptSubmit) dir="$SOUNDS_DIR/ack" ;;
  Stop)             dir="$SOUNDS_DIR/done" ;;
  Notification)     dir="$SOUNDS_DIR/input" ;;
  *) exit 0 ;;
esac

files=("$dir"/*.wav)
[[ ${#files[@]} -eq 0 ]] && exit 0

pick="${files[RANDOM % ${#files[@]}]}"
afplay -v 0.8 "$pick" &
