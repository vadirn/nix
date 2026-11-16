#!/usr/bin/env bash
# Headless checks of the Log list against a built route-console, for what its
# unit tests cannot reach: Rune's own scroll state. Each case replays a script
# from route-console/checks, in the `live` scene (a list that grows by one
# sample event every half second) unless it names another, and reads the
# element tree at its marks.
#
#   nix build .#route-console
#   scripts/check-route-console.sh [RESULT]
#
# RESULT defaults to ./result. Exits non-zero when a check fails.
set -euo pipefail

bin="${1:-result}/bin/route-console"
[ -x "$bin" ] || { echo "no binary at $bin: run nix build .#route-console first" >&2; exit 1; }
cases="$(cd "$(dirname "$0")/.." && pwd)/route-console/checks"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# The element tree of script $1 at its mark $2, in scene $3 (default live).
# The index and log directory point into the scratch directory, so a run never
# reads or writes the real ones.
tree() {
  local out="$tmp/$1-$2.json"
  "$bin" --scene "${3:-live}" --script "$cases/$1.json" --tree "$out" --size 1280x880 --scale 1 \
    --at "mark:$2" --index "$tmp/index.sqlite" --log-dir "$tmp/log" >/dev/null 2>&1
  echo "$out"
}
# The count on the "↓ N new" pill, 0 without one.
pill() { jq -r '[.elements[] | select(.key == "to-end") | .label][0] // "↓ 0" | capture("(?<n>[0-9]+)").n' "$1"; }
# The id of the row under window y $2.
row_at() {
  jq -r --argjson y "$2" '[.elements[] | select(.path | test("events-rows/[0-9]+$"))
    | select(.rect[1] <= $y and $y < .rect[1] + .rect[3])][0].path | split("/") | last' "$1"
}
# Row $2's top and bottom edges, and the viewport's.
top() { jq -r --arg id "$2" '[.elements[] | select(.path | endswith("events-rows/" + $id))][0].rect[1]' "$1"; }
bottom() { jq -r --arg id "$2" '[.elements[] | select(.path | endswith("events-rows/" + $id))][0] | .rect[1] + .rect[3]' "$1"; }
newest_bottom() {
  jq -r '[.elements[] | select(.path | test("events-rows/[0-9]+$"))]
    | max_by(.path | split("/") | last | tonumber) | .rect[1] + .rect[3]' "$1"
}
view_top() { jq -r '[.elements[] | select(.path | endswith("events-viewport"))][0].rect[1]' "$1"; }
view_bottom() { jq -r '[.elements[] | select(.path | endswith("events-viewport"))][0] | .rect[1] + .rect[3]' "$1"; }
# How many rows the list holds, and whether an element keyed $2 is drawn. An
# element fading out after it left the view is still in the tree, marked
# exiting, and counts for neither.
rows() { jq -r '[.elements[] | select(.exiting != true and (.path | test("events-rows/[0-9]+$")))] | length' "$1"; }
has() { jq -e --arg k "$2" '[.elements[] | select(.exiting != true and (.path | endswith($k)))] | length > 0' "$1" >/dev/null; }
lacks() { ! has "$@"; }
# Whether two points are within half a point.
same() { awk -v a="$1" -v b="$2" 'BEGIN { exit !(a - b < 0.5 && b - a < 0.5) }'; }
below() { awk -v a="$1" -v b="$2" 'BEGIN { exit !(a < b - 0.5) }'; }

failed=0
check() {
  if "${@:2}"; then echo "ok    $1"; else echo "FAIL  $1"; failed=1; fi
}

# A click on the newest row while following pauses the list, and the pill
# counts the rows that arrive below. This is the stopgap in App::click: without
# the reveal, Rune keeps the viewport pinned and reports the end, and no pill shows.
a="$(tree click-at-end soon)"
b="$(tree click-at-end later)"
n1="$(pill "$a")"
n2="$(pill "$b")"
id="$(row_at "$a" 858)"
check "a click at the end shows the pill ($n1 new)" test "$n1" -ge 1
check "the pill counts the rows that keep arriving ($n1 -> $n2)" test "$n2" -gt "$n1"
check "the clicked row holds still while they arrive" same "$(top "$a" "$id")" "$(top "$b" "$id")"

# A click on a row half under an edge scrolls it just into view, as the arrow
# keys do: its edge lands on the viewport's, and the list does not re-centre.
a="$(tree click-top-edge before)"
b="$(tree click-top-edge after)"
id="$(row_at "$a" 88)"
check "the top-edge row starts half hidden" below "$(top "$a" "$id")" "$(view_top "$a")"
check "a click brings its top just to the viewport's" same "$(top "$b" "$id")" "$(view_top "$b")"

a="$(tree click-bottom-edge before)"
b="$(tree click-bottom-edge after)"
id="$(row_at "$a" 869)"
check "the bottom-edge row starts half hidden" below "$(view_bottom "$a")" "$(bottom "$a" "$id")"
check "a click brings its bottom just to the viewport's" same "$(bottom "$b" "$id")" "$(view_bottom "$b")"

# The pill and End jump to the newest row and follow from there: the pill
# goes, the newest row sits on the viewport's bottom, and stays there as more
# arrive.
for how in pill end; do
  a="$(tree "jump-by-$how" paused)"
  b="$(tree "jump-by-$how" jumped)"
  c="$(tree "jump-by-$how" later)"
  check "$how: the list is paused with the pill up ($(pill "$a") new)" test "$(pill "$a")" -ge 1
  check "$how: the jump lands on the newest row" same "$(newest_bottom "$b")" "$(view_bottom "$b")"
  check "$how: the pill goes" test "$(pill "$b")" -eq 0
  check "$how: the list follows the rows that arrive after" same "$(newest_bottom "$c")" "$(view_bottom "$c")"
done

# A filter holds the picked row where it shows while rows above it leave, and
# again as they come back when it is cleared (fifteen rows, with room to
# scroll either way, so nothing clamps).
a="$(tree filter-in-place before)"
b="$(tree filter-in-place narrowed)"
c="$(tree filter-in-place widened)"
id="$(row_at "$a" 470)"
check "a filter holds the picked row while rows above it leave ($(top "$a" "$id") -> $(top "$b" "$id"))" same "$(top "$a" "$id")" "$(top "$b" "$id")"
check "and clearing it holds the row as they come back ($(top "$c" "$id"))" same "$(top "$a" "$id")" "$(top "$c" "$id")"

# Where the list is too short to hold it, it stops at the end nearer the
# row's place: here its top, the rows above having left.
a="$(tree filter-clamped before)"
b="$(tree filter-clamped narrowed)"
first_top() { jq -r '[.elements[] | select(.exiting != true and (.path | test("events-rows/[0-9]+$"))) | .rect[1]] | min' "$1"; }
check "a filter that cannot hold the row stops the list at its top" same "$(first_top "$b")" "$(view_top "$b")"

# Choosing the screen already shown changes no rows, so the pill keeps its count.
a="$(tree same-screen after)"
check "the same screen again keeps the pill ($(pill "$a") new)" test "$(pill "$a")" -ge 1

# Health mounts in the Log's place, and Rune drops an unmounted viewport's
# offset. Back from Health, a paused list is where the reader left it, its
# picked row at the same height, and its pill counts what arrived meanwhile.
a="$(tree health-trip-paused before)"
b="$(tree health-trip-paused away)"
c="$(tree health-trip-paused back)"
id="$(row_at "$a" 450)"
check "Health replaces the list" has "$b" "/health"
check "while Health shows, no list is drawn" lacks "$b" "events-viewport"
check "back from Health, the picked row is where it was" same "$(top "$a" "$id")" "$(top "$c" "$id")"
check "and the pill counts the rows that came meanwhile ($(pill "$a") -> $(pill "$c"))" test "$(pill "$c")" -gt "$(pill "$a")"

# Coming back on another hook event, the picked row keeps its place: the list
# comes back moved by the rows the filter took from above it (fifteen here,
# with room left to scroll, so nothing clamps).
a="$(tree health-trip-filter before)"
c="$(tree health-trip-filter back)"
id="$(row_at "$a" 470)"
check "the picked row is a PreToolUse row, kept by the filter" has "$c" "events-rows/$id"
check "back from Health on PreToolUse, the picked row is where it was ($(top "$a" "$id") -> $(top "$c" "$id"))" same "$(top "$a" "$id")" "$(top "$c" "$id")"

# A list that was following comes back following, at its newest row.
a="$(tree health-trip-following back)"
check "back from Health, a following list is at its newest row" same "$(newest_bottom "$a")" "$(view_bottom "$a")"
check "with no pill" test "$(pill "$a")" -eq 0

# "Show events" lists exactly the events an issue counts (the health scene's
# first issue: no-secrets.sh failing on three Bash calls), with a filter the
# toolbar shows and clears.
a="$(tree show-events shown health)"
b="$(tree show-events cleared health)"
check "Show events lists the issue's 3 events ($(rows "$a"))" test "$(rows "$a")" -eq 3
check "the toolbar shows the issue filter" has "$a" "issue-filter"
check "clearing it lists the hook event's rows ($(rows "$b"))" test "$(rows "$b")" -gt 3
check "and the filter goes" lacks "$b" "issue-filter"

exit "$failed"
