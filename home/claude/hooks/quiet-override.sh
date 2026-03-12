#!/bin/bash
# Inject quiet flags into verbose commands via updatedInput.
# Saves tokens by suppressing progress bars, banners, and status output.
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command')

emit() {
  jq -n --arg cmd "$1" '{
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "updatedInput": { "command": $cmd }
    }
  }'
  exit 0
}

# try_quiet MATCH_PATTERN SKIP_PATTERN SED_REPLACEMENT
try_quiet() {
  local match="$1" skip="$2" replacement="$3"
  if [[ "$COMMAND" =~ $match ]] && [[ ! "$COMMAND" =~ $skip ]]; then
    emit "$(printf '%s' "$COMMAND" | sed -E "$replacement")"
  fi
}

try_quiet \
  '(^|[[:space:]])git[[:space:]]+(commit|clone|fetch|pull)' \
  '(-q|--quiet)' \
  's/(git[[:space:]]+(commit|clone|fetch|pull))/\1 -q/'

try_quiet \
  '^npm[[:space:]]+(install|i|ci)([[:space:]]|$)' \
  '(--silent|--quiet|\||>|&)' \
  's/^(npm[[:space:]]+(install|i|ci))/\1 --silent/'

try_quiet \
  '^cargo[[:space:]]+build' \
  '(-q|--quiet|\||>|&)' \
  's/^(cargo[[:space:]]+build)/\1 -q/'

try_quiet \
  '^make([[:space:]]|$)' \
  '(-s|--silent|\||>|&)' \
  's/^make/make -s/'

try_quiet \
  '(^|python3?[[:space:]]+-m[[:space:]]+)pip3?[[:space:]]+(install|download)' \
  '(-q|--quiet)' \
  's/(pip3?[[:space:]]+(install|download))/\1 -q/'

try_quiet \
  '^wget[[:space:]]' \
  '(-q|--quiet|-O)' \
  's/^wget/wget -q/'

try_quiet \
  '^docker[[:space:]]+(build|pull)' \
  '(-q|--quiet|\|)' \
  's/^(docker[[:space:]]+(build|pull))/\1 -q/'

try_quiet \
  '(^|[[:space:]])ffmpeg[[:space:]]' \
  '-nostats' \
  's/(^|[[:space:]])ffmpeg[[:space:]]/\1ffmpeg -nostats -loglevel error /'

exit 0
