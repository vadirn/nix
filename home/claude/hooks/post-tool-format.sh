#!/usr/bin/env bash
# PostToolUse hook: format the file just written or edited.
#
# JS/TS/JSON branch (designed in docs/spikes/2026-05-27-oxfmt-formatter-detection.md):
#   - Skips Edit/MultiEdit to prevent Edit-round-trip failures.
#   - Walks up for a project manifest (package.json, deno.json), bounded by
#     .git, $HOME, or filesystem root. No manifest = no formatting.
#   - For package.json: reads devDependencies/dependencies; picks biome >
#     prettier > dprint, or falls back to global oxfmt when no JS formatter
#     is declared. Prefers ./node_modules/.bin/<bin> over global binaries.
#   - For deno.json: runs `deno fmt`.
#
# Never blocks: failures go to stderr so Claude can see and decide.
# Exit 0 always.

set -uo pipefail

INPUT=$(cat)
TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty')
FILE=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty')

[ -n "$FILE" ] || exit 0
[ -f "$FILE" ] || exit 0

ext="${FILE##*.}"

find_js_project_root() {
  local dir
  dir=$(dirname "$1")
  while :; do
    if [ -f "$dir/package.json" ] || [ -f "$dir/deno.json" ] || [ -f "$dir/deno.jsonc" ]; then
      printf '%s\n' "$dir"
      return
    fi
    [ -d "$dir/.git" ] && return
    [ "$dir" = "${HOME:-/nonexistent}" ] && return
    [ "$dir" = "/" ] && return
    dir=$(dirname "$dir")
  done
}

identify_js_formatter() {
  local pkg=$1
  if jq -e '(.devDependencies["@biomejs/biome"] // .dependencies["@biomejs/biome"]) // empty' "$pkg" >/dev/null 2>&1; then
    printf 'biome\n'; return
  fi
  if jq -e '(.devDependencies.prettier // .dependencies.prettier) // empty' "$pkg" >/dev/null 2>&1; then
    printf 'prettier\n'; return
  fi
  if jq -e '(.devDependencies.dprint // .dependencies.dprint) // empty' "$pkg" >/dev/null 2>&1; then
    printf 'dprint\n'; return
  fi
  printf 'oxfmt\n'
}

run_local_or_global() {
  local root=$1 bin=$2
  shift 2
  if [ -x "$root/node_modules/.bin/$bin" ]; then
    (cd "$root" && "./node_modules/.bin/$bin" "$@" >&2) || true
  elif command -v "$bin" >/dev/null 2>&1; then
    (cd "$root" && "$bin" "$@" >&2) || true
  fi
}

case "$ext" in
  ts|tsx|js|jsx|mjs|cjs|json|jsonc)
    case "$TOOL" in
      Edit|MultiEdit) exit 0 ;;
    esac
    root=$(find_js_project_root "$FILE")
    [ -n "$root" ] || exit 0
    if [ -f "$root/package.json" ]; then
      tool=$(identify_js_formatter "$root/package.json")
      case "$tool" in
        biome)    run_local_or_global "$root" biome    format --write "$FILE" ;;
        prettier) run_local_or_global "$root" prettier --write "$FILE" ;;
        dprint)   run_local_or_global "$root" dprint   fmt "$FILE" ;;
        oxfmt)
          command -v oxfmt >/dev/null 2>&1 || exit 0
          oxfmt "$FILE" >&2 || true
          ;;
      esac
    elif [ -f "$root/deno.json" ] || [ -f "$root/deno.jsonc" ]; then
      command -v deno >/dev/null 2>&1 || exit 0
      (cd "$root" && deno fmt "$FILE" >&2) || true
    fi
    ;;
  py)
    command -v ruff >/dev/null 2>&1 || exit 0
    ruff check --fix --quiet "$FILE" >&2 || true
    ruff format --quiet "$FILE" >&2 || true
    ;;
  nix)
    command -v alejandra >/dev/null 2>&1 || exit 0
    alejandra --quiet "$FILE" >&2 || true
    ;;
  rs)
    # rustfmt runs on save via the editor; running it here causes loops.
    ;;
  *)
    ;;
esac

exit 0
