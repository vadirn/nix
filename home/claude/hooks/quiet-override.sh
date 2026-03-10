#!/bin/bash
# Inject quiet flags into verbose commands via updatedInput.
# Saves tokens by suppressing progress bars, banners, and status output.
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command')

quiet() {
  jq -n --arg cmd "$1" '{
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "updatedInput": { "command": $cmd }
    }
  }'
  exit 0
}

# git commit/clone/fetch/pull → -q
if [[ "$COMMAND" =~ git[[:space:]]+(commit|clone|fetch|pull) ]] && [[ ! "$COMMAND" =~ (-q|--quiet) ]]; then
  QUIET_CMD=$(printf '%s' "$COMMAND" | sed -E 's/(git[[:space:]]+(commit|clone|fetch|pull))/\1 -q/')
  quiet "$QUIET_CMD"
fi

# npm install/ci → --silent
if [[ "$COMMAND" =~ ^npm[[:space:]]+(install|i|ci)([[:space:]]|$) ]] && [[ ! "$COMMAND" =~ (--silent|--quiet|\||'>'|'&') ]]; then
  QUIET_CMD=$(printf '%s' "$COMMAND" | sed -E 's/^(npm[[:space:]]+(install|i|ci))/\1 --silent/')
  quiet "$QUIET_CMD"
fi

# cargo build → -q
if [[ "$COMMAND" =~ ^cargo[[:space:]]+build ]] && [[ ! "$COMMAND" =~ (-q|--quiet|\||'>'|'&') ]]; then
  QUIET_CMD=$(printf '%s' "$COMMAND" | sed -E 's/^(cargo[[:space:]]+build)/\1 -q/')
  quiet "$QUIET_CMD"
fi

# make → -s
if [[ "$COMMAND" =~ ^make([[:space:]]|$) ]] && [[ ! "$COMMAND" =~ (-s|--silent|\||'>'|'&') ]]; then
  QUIET_CMD=$(printf '%s' "$COMMAND" | sed -E 's/^make/make -s/')
  quiet "$QUIET_CMD"
fi

# pip install/download → -q
if [[ "$COMMAND" =~ (^|python3?[[:space:]]+-m[[:space:]]+)pip3?[[:space:]]+(install|download) ]] && [[ ! "$COMMAND" =~ (-q|--quiet) ]]; then
  QUIET_CMD=$(printf '%s' "$COMMAND" | sed -E 's/(pip3?[[:space:]]+(install|download))/\1 -q/')
  quiet "$QUIET_CMD"
fi

# wget → -q
if [[ "$COMMAND" =~ ^wget[[:space:]] ]] && [[ ! "$COMMAND" =~ (-q|--quiet|-O) ]]; then
  QUIET_CMD=$(printf '%s' "$COMMAND" | sed -E 's/^wget/wget -q/')
  quiet "$QUIET_CMD"
fi

# docker build/pull → -q
if [[ "$COMMAND" =~ ^docker[[:space:]]+(build|pull) ]] && [[ ! "$COMMAND" =~ (-q|--quiet|\|) ]]; then
  QUIET_CMD=$(printf '%s' "$COMMAND" | sed -E 's/^(docker[[:space:]]+(build|pull))/\1 -q/')
  quiet "$QUIET_CMD"
fi

# ffmpeg → -nostats -loglevel error
if [[ "$COMMAND" =~ (^|[[:space:]|;&])ffmpeg[[:space:]] ]] && [[ ! "$COMMAND" =~ -nostats ]]; then
  QUIET_CMD=$(printf '%s' "$COMMAND" | sed -E 's/(^|[[:space:]])ffmpeg[[:space:]]/\1ffmpeg -nostats -loglevel error /')
  quiet "$QUIET_CMD"
fi

exit 0
