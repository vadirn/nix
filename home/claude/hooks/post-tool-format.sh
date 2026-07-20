#!/usr/bin/env bash
# Format one file, routed by extension. Two entry points (see settings.json):
#
#   - PostToolUse Write matcher: path arrives as hook JSON on stdin. Write
#     replaces whole content, so reflowing right away is safe.
#   - flush-format-queue.sh (Stop hook): path arrives as $1. Edits are never
#     formatted mid-turn — a formatter reflowing the file between two Edits
#     in one turn makes the second Edit's old_string fail to match — so
#     queue-format.sh defers them to the turn boundary.
#
# JS/TS/JSON + web + markdown branch (extensions oxfmt handles natively):
#   - Walks up looking for a package.json that defines a `format:file` script
#     (convention: takes one path arg, formats that file in place). The walk
#     is bounded by .git, $HOME, or filesystem root. Workspace-root scripts
#     are inherited — a sub-package without `format:file` does NOT terminate
#     the walk.
#   - When found, runs it via the detected package manager (bun > pnpm >
#     yarn > npm) from the manifest's dir.
#   - For deno.json: runs `deno fmt` at the nearest deno root.
#   - Universal fallback: global oxfmt on the file. Runs when no ancestor
#     defines `format:file`, including the no-manifest case (scratch files,
#     vault .md, etc.). oxfmt's own config discovery walks up from the cwd and
#     stops at .git, so the hook resolves config itself: nearest .oxfmtrc.json
#     between the file and its repo root, else -c ~/.oxfmtrc.json (see
#     home/bun/oxfmtrc.json, deployed to ~ — sets proseWrap: never). Easy to
#     spot when oxfmt's defaults diverge from project style — that's the cue
#     to add `format:file`.
#
# Never blocks: failures go to stderr so Claude can see and decide.
# Exit 0 always.

set -uo pipefail

# shellcheck source=lib/detect-pm.sh
source "$(dirname "$0")/lib/detect-pm.sh"

if [ $# -ge 1 ]; then
  FILE=$1
else
  INPUT=$(cat)
  # Newline-delimited so paths with spaces (e.g. vault's "35 experiments/") survive.
  { IFS= read -r FILE; } < <(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // ""')
fi

[ -n "$FILE" ] || exit 0
[ -f "$FILE" ] || exit 0

# vault-archive holds write-once, content-hash-addressed source snapshots
# (frozen provenance): reflowing one silently diverges the stored bytes from
# the hash recorded on its reference stub.
case "$FILE" in
  "${HOME:-/nonexistent}/Documents/vault-archive/"*) exit 0 ;;
esac

ext="${FILE##*.}"

manifest_has_format_file() {
  jq -e '.scripts."format:file"' "$1" >/dev/null 2>&1
}

# Walk up from $1 looking for the formatter to use. Emits two lines —
# <root_dir>\n<tool> — where tool is "script" (project's format:file),
# "deno", or "oxfmt". Newline-delimited so root paths with spaces survive.
# A package.json without format:file does NOT terminate the walk —
# workspace-root scripts are inherited. Always emits something: oxfmt is the
# universal fallback (no-manifest scratch files included). The root value is
# meaningful for "script" and "deno"; for "oxfmt" it's only kept for trace.
resolve_js_formatter() {
  local file=$1
  local dir saw_pkg=""
  dir=$(dirname "$file")
  while :; do
    if [ -f "$dir/package.json" ]; then
      if manifest_has_format_file "$dir/package.json"; then
        printf '%s\nscript\n' "$dir"
        return
      fi
      [ -z "$saw_pkg" ] && saw_pkg=$dir
    elif [ -f "$dir/deno.json" ] || [ -f "$dir/deno.jsonc" ]; then
      if [ -z "$saw_pkg" ]; then
        printf '%s\ndeno\n' "$dir"
        return
      fi
    fi
    [ -e "$dir/.git" ] && break
    case "$dir" in
      "" | . | / | "${HOME:-/nonexistent}") break ;;
    esac
    dir=$(dirname "$dir")
  done
  printf '%s\noxfmt\n' "${saw_pkg:-$(dirname "$file")}"
}

run_format_file() {
  local root=$1 file=$2
  local pm
  pm=$(detect_pm "$root")
  pm="${pm:-npm}"
  # npm needs `--` to forward args to the script; bun/pnpm/yarn don't.
  # Gotcha: bun resets TMPDIR for the spawned format:file subprocess to the
  # macOS user-temp (/private/var/folders/.../T/) rather than inheriting this
  # hook's TMPDIR. A script using $TMPDIR for caching or trace logs writes
  # there, not into the Claude session scratch dir. Access is allowed (the
  # macOS user-temp is sandbox-writable), but the files survive the session.
  case "$pm" in
    npm) (cd "$root" && npm run format:file -- "$file" >&2) || true ;;
    *) (cd "$root" && "$pm" run format:file "$file" >&2) || true ;;
  esac
}

case "$ext" in
  ts | tsx | js | jsx | mjs | cjs | json | jsonc | md | html | css)
    { IFS= read -r root && IFS= read -r tool; } < <(resolve_js_formatter "$FILE")
    case "$tool" in
      script) run_format_file "$root" "$FILE" ;;
      deno)
        command -v deno >/dev/null 2>&1 || exit 0
        (cd "$root" && deno fmt "$FILE" >&2) || true
        ;;
      oxfmt)
        command -v oxfmt >/dev/null 2>&1 || exit 0
        # oxfmt discovers .oxfmtrc.json by walking up from the cwd and stops at
        # a .git boundary, so inside a repo without its own config the global
        # ~/.oxfmtrc.json is never found and oxfmt falls back to its defaults
        # (proseWrap: preserve). Walk up from the file ourselves; when no config
        # exists between the file and the repo root, pass the global one.
        cfg_dir=$(dirname "$FILE")
        cfg_args=()
        while :; do
          [ -f "$cfg_dir/.oxfmtrc.json" ] && break
          if [ -e "$cfg_dir/.git" ] || [ "$cfg_dir" = "${HOME:-/nonexistent}" ] || [ "$cfg_dir" = "/" ]; then
            [ -f "${HOME:-/nonexistent}/.oxfmtrc.json" ] && cfg_args=(-c "$HOME/.oxfmtrc.json")
            break
          fi
          cfg_dir=$(dirname "$cfg_dir")
        done
        oxfmt ${cfg_args[@]+"${cfg_args[@]}"} "$FILE" >&2 || true
        ;;
    esac
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
  *) ;;
esac

exit 0
