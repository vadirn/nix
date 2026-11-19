#!/usr/bin/env bash
# Pick a GIF for a PR template's GIF section from the git skill's library,
# references/gifs.json, a map of title to URL.
#
#   pr-gif                     list the titles, one per line
#   pr-gif <title>             print the markdown embed for that title
#   pr-gif add <title> <url>   add a GIF, refusing one GitHub will not render
#
# Exit codes: 0 on success, 1 on an unknown title or a refused add, 2 on misuse.

set -euo pipefail

script_dir=$(dirname "$(readlink -f "$0")")
lib="$script_dir/../skills/git/references/gifs.json"
max=$((5 * 1024 * 1024)) # GitHub's image proxy refuses a larger image

fail() {
  echo "pr-gif: $1" >&2
  exit 1
}

case "${1-}" in
"")
  jq -r 'keys_unsorted[]' "$lib"
  ;;
add)
  [ $# -eq 3 ] || {
    echo "usage: pr-gif add <title> <url>" >&2
    exit 2
  }
  title=$2 url=$3
  case $url in
  *tenor.com/m/*) fail "a Tenor /m/ link returns 404 on some requests; use media.tenor.com/<id>/<slug>.gif" ;;
  esac
  if jq -e --arg t "$title" 'has($t)' "$lib" >/dev/null; then
    fail "the library already has a GIF titled: $title"
  fi
  read -r code size < <(curl -sIL -o /dev/null -w '%{http_code} %header{content-length}\n' "$url")
  [ "$code" = 200 ] || fail "$url returned HTTP $code"
  [ -n "${size-}" ] || fail "$url sent no content-length, so its size is unknown"
  [ "$size" -le "$max" ] || fail "$url is $size bytes; GitHub's image proxy refuses over $max"
  tmp=$(mktemp)
  jq --arg t "$title" --arg u "$url" '{($t): $u} + .' "$lib" >"$tmp"
  mv "$tmp" "$lib"
  ;;
*)
  jq -er --arg t "$1" '.[$t] // empty | "![](\(.))"' "$lib" || fail "no GIF titled: $1"
  ;;
esac
