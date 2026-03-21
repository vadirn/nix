#!/usr/bin/env bash
set -euo pipefail
shopt -s nullglob

SOUNDS_DIR="$HOME/.claude/hooks/sounds"

case "${1:-}" in
  SessionStart)        dir="$SOUNDS_DIR/start" ;;
  UserPromptSubmit)    dir="$SOUNDS_DIR/ack" ;;
  Stop)                dir="$SOUNDS_DIR/done" ;;
  Notification)        dir="$SOUNDS_DIR/input" ;;
  TaskCompleted)       dir="$SOUNDS_DIR/task-complete" ;;
  PostToolUseFailure)  dir="$SOUNDS_DIR/error" ;;
  *) exit 0 ;;
esac

files=("$dir"/*.{wav,mp3,ogg})
[[ ${#files[@]} -eq 0 ]] && exit 0

pick="${files[RANDOM % ${#files[@]}]}"
pkill -x afplay 2>/dev/null || true
afplay -v 0.8 "$pick" &
