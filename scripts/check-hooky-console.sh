#!/usr/bin/env bash
# Headless checks of the Log list against a built hooky-console, for what its
# unit tests cannot reach: Rune's own scroll state. Each case replays a script
# from hooky-console/checks, in the `live` scene (a list that grows by one
# sample event every half second) unless it names another, and reads the
# element tree at its marks.
#
#   nix build .#hooky-console
#   scripts/check-hooky-console.sh [RESULT]
#
# RESULT defaults to ./result. Exits non-zero when a check fails.
set -euo pipefail

bin="${1:-result}/bin/hooky-console"
[ -x "$bin" ] || { echo "no binary at $bin: run nix build .#hooky-console first" >&2; exit 1; }
cases="$(cd "$(dirname "$0")/.." && pwd)/hooky-console/checks"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# The element tree of script $1 at its mark $2, in scene $3 (default live).
# The index, log directory and state file point into the scratch directory, so
# a run never reads or writes the real ones (the sample scenes keep their
# toggles in memory besides).
tree() {
  local out="$tmp/$1-$2.json"
  "$bin" --scene "${3:-live}" --script "$cases/$1.json" --tree "$out" --size 1280x880 --scale 1 \
    --at "mark:$2" --index "$tmp/index.sqlite" --log-dir "$tmp/log" --state "$tmp/state.json" \
    >/dev/null 2>&1
  echo "$out"
}
# The height of everything the list holds, drawn or not: it grows a row at a
# time as rows load.
held() { jq -r '[.elements[] | select(.path | endswith("events-rows"))][0].rect[3]' "$1"; }
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
# Whether an element's text or label is $2.
says() { jq -e --arg w "$2" '[.elements[] | select((.text // .label) == $w)] | length > 0' "$1" >/dev/null; }
# Whether two points are within half a point.
same() { awk -v a="$1" -v b="$2" 'BEGIN { exit !(a - b < 0.5 && b - a < 0.5) }'; }
below() { awk -v a="$1" -v b="$2" 'BEGIN { exit !(a < b - 0.5) }'; }

failed=0
check() {
  if "${@:2}"; then echo "ok    $1"; else echo "FAIL  $1"; failed=1; fi
}

# A click on the newest row while following pauses the list, the pill shows,
# and rows keep loading below. This is the stopgap in App::click: without the
# reveal, Rune keeps the viewport pinned and reports the end, and no pill shows.
a="$(tree click-at-end soon)"
b="$(tree click-at-end later)"
id="$(row_at "$a" 858)"
check "a click at the end shows the pill" has "$a" to-end
check "rows keep loading below it ($(held "$a") -> $(held "$b"))" below "$(held "$a")" "$(held "$b")"
check "and it stays" has "$b" to-end
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

# The pill floats centred over the list's foot, 16 points up.
a="$(tree jump-by-pill paused)"
mid() { jq -r --arg k "$2" '[.elements[] | select(.path | endswith($k))][0] | .rect[0] + .rect[2] / 2' "$1"; }
foot() { jq -r --arg k "$2" '[.elements[] | select(.path | endswith($k))][0] | .rect[1] + .rect[3]' "$1"; }
check "the pill is centred over the list ($(mid "$a" to-end) / $(mid "$a" events-viewport))" same "$(mid "$a" to-end)" "$(mid "$a" events-viewport)"
check "16 points above its foot ($(foot "$a" to-end) / $(foot "$a" events-viewport))" same "$(foot "$a" to-end)" "$(awk -v b="$(foot "$a" events-viewport)" 'BEGIN { print b - 16 }')"

# The pill and End jump to the newest row and follow from there: the pill
# goes, the newest row sits on the viewport's bottom, and stays there as more
# arrive.
for how in pill end; do
  a="$(tree "jump-by-$how" paused)"
  b="$(tree "jump-by-$how" jumped)"
  c="$(tree "jump-by-$how" later)"
  check "$how: the list is paused with the pill up" has "$a" to-end
  check "$how: the jump lands on the newest row" same "$(newest_bottom "$b")" "$(view_bottom "$b")"
  check "$how: the pill goes" lacks "$b" to-end
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

# Choosing the screen already shown changes no rows, so the pill stays.
a="$(tree same-screen after)"
check "the same screen again keeps the pill" has "$a" to-end

# Health mounts in the Log's place, and Rune drops an unmounted viewport's
# offset. Back from Health, a paused list is where the reader left it, its
# picked row at the same height, and what arrived meanwhile loaded below it.
a="$(tree health-trip-paused before)"
b="$(tree health-trip-paused away)"
c="$(tree health-trip-paused back)"
id="$(row_at "$a" 450)"
check "Health replaces the list" has "$b" "/health"
check "while Health shows, no list is drawn" lacks "$b" "events-viewport"
check "back from Health, the picked row is where it was" same "$(top "$a" "$id")" "$(top "$c" "$id")"
check "the rows that came meanwhile loaded below ($(held "$a") -> $(held "$c"))" below "$(held "$a")" "$(held "$c")"
check "and the pill is up" has "$c" to-end

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
check "with no pill" lacks "$a" to-end

# "Show events" lists exactly the events an issue counts (the health scene's
# first issue: no-secrets.sh failing on three Bash calls), with a filter the
# toolbar shows and clears.
a="$(tree show-events shown health)"
b="$(tree show-events cleared health)"
check "Show events lists the issue's 3 events ($(rows "$a"))" test "$(rows "$a")" -eq 3
check "the toolbar shows the issue filter" has "$a" "issue-filter"
check "clearing it lists the hook event's rows ($(rows "$b"))" test "$(rows "$b")" -gt 3
check "and the filter goes" lacks "$b" "issue-filter"

# Nothing springs or fades: 50 ms after a click (the script's tap releases
# 80 ms after it presses), the inspector already shows the new pick as it
# rests, nothing is fading, and a row half under the top edge is in view.
a="$(tree no-motion picked)"
b="$(tree no-motion settled)"
c="$(tree no-motion revealed)"
panel() { jq -c '[.elements[] | select(.path | test("inspector")) | [.path, .rect, .opacity, .fill]]' "$1"; }
check "a pick lands in the inspector at once" test "$(panel "$a")" = "$(panel "$b")"
check "with nothing fading out" test "$(jq '[.elements[] | select(.exiting == true)] | length' "$a")" -eq 0
id="$(row_at "$b" 88)"
check "a click on a row under the top edge scrolls it in at once" same "$(top "$c" "$id")" "$(view_top "$c")"

# From a blocked event to one with no verdict (the health scene's rows 2 and
# 11), the title takes the badge's place with no trace of its fill.
a="$(tree block-to-plain picked health)"
b="$(tree block-to-plain settled health)"
check "block to no verdict lands at once, colours included" test "$(panel "$a")" = "$(panel "$b")"

# Hover comes and goes at once: 30 ms after the pointer leaves a row (the
# canvas scene's fourth), its hover track is back to nothing. The tree keeps
# hover as its own track, 0 to 1, not in the row's fill.
a="$(tree hover hovered canvas)"
b="$(tree hover left canvas)"
hover_at() { jq -r --argjson y "$2" '[.elements[] | select(.path | test("events-rows/[0-9]+$"))
  | select(.rect[1] <= $y and $y < .rect[1] + .rect[3])][0].hover // 0' "$1"; }
near() { awk -v a="$1" -v b="$2" 'BEGIN { exit !(a - b < 0.01 && b - a < 0.01) }'; }
check "a hovered row lights up ($(hover_at "$a" 183))" near "$(hover_at "$a" 183)" 1
check "and goes dark at once when the pointer leaves ($(hover_at "$b" 183))" near "$(hover_at "$b" 183)" 0

# Besides a switch of spaces, the sidebar is the one thing that moves: it
# slides shut over frames, and
# the Log widens with its card, the inspector held to the card's right edge,
# rather than landing at its final width and riding in with the card.
a="$(tree sidebar-slide open)"
b="$(tree sidebar-slide sliding)"
c="$(tree sidebar-slide shut)"
width() { jq -r --arg k "$2" '[.elements[] | select(.path | endswith($k))][0].rect[2]' "$1"; }
right() { jq -r --arg k "$2" '[.elements[] | select(.path | endswith($k))][0] | .rect[0] + .rect[2]' "$1"; }
gap() { awk -v a="$(right "$1" main-pane)" -v b="$(right "$1" /inspector)" 'BEGIN { print a - b }'; }
check "the sidebar slides ($(width "$a" sidebar-pane) -> $(width "$b" sidebar-pane) -> $(width "$c" sidebar-pane))" \
  awk -v a="$(width "$a" sidebar-pane)" -v b="$(width "$b" sidebar-pane)" -v c="$(width "$c" sidebar-pane)" 'BEGIN { exit !(a > b + 0.5 && b > c + 0.5) }'
check "and the inspector keeps to the card's right edge ($(gap "$a") / $(gap "$b") / $(gap "$c"))" same "$(gap "$b")" "$(gap "$a")"

# Handlers: a switch turned off brings up the status bar with "Enable all",
# which turns it back on and takes the bar away. Nothing is written: the
# sample scenes toggle in memory.
a="$(tree handlers-toggle before handlers)"
b="$(tree handlers-toggle off handlers)"
c="$(tree handlers-toggle on handlers)"
check "Handlers opens with every handler on" lacks "$a" "/status"
check "a switch turned off shows the status bar" has "$b" "enable-all"
check "Enable all takes it away" lacks "$c" "/status"
check "and nothing reached a state file" test ! -e "$tmp/state.json"

# Handlers: under an event's groups, the hooks a project wires itself, with no
# switch; an event only such hooks use gets its own block.
outside_switches() {
  jq -r '[.elements[] | select(.exiting != true and (.path | test("outside-")) and (.path | test("switch-")))] | length' "$1"
}
check "a project's own PreToolUse hook lists outside hooky" has "$a" "outside-PreToolUse-0"
check "under its heading" says "$a" "Outside hooky"
check "with no switch ($(outside_switches "$a"))" test "$(outside_switches "$a")" -eq 0
check "an event only a project hooks gets a block" has "$a" "outside-PreCompact-0"
check "a hook wired straight into the settings file is badged so" says "$a" "your settings"

# Each sidebar row is a page, and one row lights at a time. The Handlers
# row lists every hook event's handlers. A hook event opens its own page from
# any screen: the Log of that event alone, without the Event column, its
# handlers and switches beside it, each guard showing what it did for the
# picked row (the canvas scene's newest, a PreToolUse Bash call two guards
# denied). A pick of another event waits in the Log, and an event with no
# rows says so above its handlers.
a="$(tree event-pages all canvas)"
b="$(tree event-pages pre canvas)"
c="$(tree event-pages stop canvas)"
d="$(tree event-pages empty canvas)"
e="$(tree event-pages log canvas)"
lit() {
  jq -r '[.elements[] | select(.exiting != true and .itemSelected == true and (.path | test("/(head|hooks)-")))
    | .key] | join(",")' "$1"
}
denied() {
  jq -r '[.elements[] | select(.exiting != true and (.path | test("handlers-PreToolUse/")) and .label == "deny")] | length' "$1"
}
check "Handlers lights alone ($(lit "$a"))" test "$(lit "$a")" = screen-handlers
check "and lists every event" has "$a" "handlers-SessionStart"
check "from Handlers, PreToolUse opens its page, lit alone ($(lit "$b"))" test "$(lit "$b")" = event-PreToolUse
check "its rows show" has "$b" "events-viewport"
check "without the Event column" lacks "$b" "header/event"
check "beside its handlers' switches" has "$b" "switch-PreToolUse-0-0"
check "the guards that denied the picked row say so ($(denied "$b"))" test "$(denied "$b")" -eq 2
check "and the toolbar opens hooks.json" has "$b" "open-hooks"
check "Stop's page lights alone ($(lit "$c"))" test "$(lit "$c")" = event-Stop
check "with only Stop's handlers" has "$c" "handlers-Stop"
check "and not PreToolUse's" lacks "$c" "handlers-PreToolUse"
check "beside Stop's rows" has "$c" "events-viewport"
check "a PreToolUse pick waits in the Log, not shown on Stop's page" lacks "$c" "/replay"
check "an event with no rows says so" says "$d" "No SessionStart events today"
check "centred over the list ($(mid "$d" /empty) / $(mid "$d" events-viewport))" same "$(mid "$d" /empty)" "$(mid "$d" events-viewport)"
check "above its handlers" has "$d" "handlers-SessionStart"
check "the Log row lights alone ($(lit "$e"))" test "$(lit "$e")" = screen-log
check "with the Event column back" has "$e" "header/event"
check "and the pick back in its inspector" has "$e" "/replay"
check "and no handlers' switches" lacks "$e" "switch-PreToolUse-0-0"

# Spaces: each harness's space lists only its own rows, under its own name
# and hook events, and a trip to the other leaves the Log where it was, as a
# trip to Health does. The spaces scene's Codex has a guard writing to
# stderr, so its icon carries a dot while Claude Code's space shows.
a="$(tree spaces before spaces)"
b="$(tree spaces away spaces)"
c="$(tree spaces back spaces)"
id="$(row_at "$a" 450)"
name() { jq -r '[.elements[] | select(.exiting != true and (.path | test("space-name/"))) | .text // empty][0]' "$1"; }
check "Claude Code's space is named above Log ($(name "$a"))" test "$(name "$a")" = "Claude Code"
check "Codex's icon is dotted for its Health's issue" has "$a" "space-codex/space-issues"
check "Claude Code's, shown, is not" lacks "$a" "space-claude/space-issues"
check "Codex's space lists only its 7 rows ($(rows "$b"))" test "$(rows "$b")" -eq 7
check "under its own name ($(name "$b"))" test "$(name "$b")" = "Codex"
check "with Codex's hook events" has "$b" "event-Interrupt"
check "and none of Claude Code's own" lacks "$b" "event-SessionEnd"
check "its icon, shown, loses the dot" lacks "$b" "space-codex/space-issues"
check "back in Claude Code's, the picked row is where it was ($(top "$a" "$id") -> $(top "$c" "$id"))" same "$(top "$a" "$id")" "$(top "$c" "$id")"
check "the rows that came meanwhile loaded below ($(held "$a") -> $(held "$c"))" below "$(held "$a")" "$(held "$c")"
check "and the pill is up" has "$c" to-end
a="$(tree spaces-following back spaces)"
check "a following list comes back from Codex at its newest row" same "$(newest_bottom "$a")" "$(view_bottom "$a")"
check "with no pill" lacks "$a" to-end
check "and nothing reached either state file" test ! -e "$tmp/state.json" -a ! -e "$tmp/codex/state.json"
# Each space keeps its own filter: Claude Code's Stop narrows neither
# Codex's list nor goes when Codex shows.
a="$(tree spaces-filter narrowed spaces)"
b="$(tree spaces-filter away spaces)"
c="$(tree spaces-filter back spaces)"
check "Stop narrows Claude Code's list ($(rows "$a"))" test "$(rows "$a")" -lt 40
check "but not Codex's ($(rows "$b"))" test "$(rows "$b")" -eq 7
check "and Claude Code's is narrowed still when it comes back ($(rows "$c"))" test "$(rows "$c")" -lt 40
# Each space keeps its own screen: Health left in Claude Code's waits there
# while Codex opens on its own Log, and Codex's Handlers wait in turn.
a="$(tree spaces-screens codex spaces)"
b="$(tree spaces-screens claude spaces)"
c="$(tree spaces-screens codex-again spaces)"
picked() {
  jq -r '[.elements[] | select(.exiting != true and .itemSelected == true and (.path | test("/head-")))
    | .key] | join(",")' "$1"
}
check "Health in Claude Code's leaves Codex's on its Log ($(picked "$a"))" test "$(picked "$a")" = screen-log
check "which shows" has "$a" "events-viewport"
check "back in Claude Code's, Health is picked ($(picked "$b"))" test "$(picked "$b")" = screen-health
check "and shows" lacks "$b" "events-viewport"
check "back in Codex's, its Handlers are ($(picked "$c"))" test "$(picked "$c")" = screen-handlers
# A switch slides the sidebar's contents sideways, the one motion it makes.
# 70 ms in, from Claude Code's Log narrowed to an issue, Codex's come in from
# the right as Claude Code's leave to the left, while the rest of the window
# already shows as it rests: the screen whole, the toolbar's title at its
# width, the issue filter gone, the sidebar's foot in its colours.
a="$(tree spaces-slide filtered spaces)"
b="$(tree spaces-slide sliding spaces)"
c="$(tree spaces-slide settled spaces)"
x() { jq -r --arg k "$2" '[.elements[] | select(.path | endswith($k))][0].rect[0]' "$1"; }
rest() {
  jq -c '[.elements[] | select(.path | test("/(head|hooks)-(claude|codex)") | not)
    | [.path, .rect, .opacity, .fill, .color, .exiting]] | sort' "$1"
}
check "Claude Code's Log shows the issue filter" has "$a" "issue-filter"
check "on a switch, Codex's sidebar contents come in from the right ($(x "$b" head-codex) -> $(x "$c" head-codex))" \
  below "$(x "$c" head-codex)" "$(x "$b" head-codex)"
check "as Claude Code's leave to the left ($(x "$b" head-claude))" below "$(x "$b" head-claude)" "$(x "$c" head-codex)"
check "while the rest of the window shows as it rests" test "$(rest "$b")" = "$(rest "$c")"
check "and the slide ends" test "$(jq '[.elements[] | select(.exiting == true)] | length' "$c")" -eq 0

# Replay runs hooky, the binary Claude Code runs, on the canvas scene's
# newest event, a Bash call: the guards that ran show beside the logged
# answer. Skipped when this Mac has no hooky.
if [ -x "$HOME/.local/bin/hooky" ]; then
  a="$(tree replay before canvas)"
  b="$(tree replay replayed canvas)"
  check "no replay before the button" lacks "$a" "replay-result"
  check "a replay lists the guards that ran" has "$b" "replayed-0"
  # A denying guard switched off on PreToolUse's page (no-dangerous.py,
  # which denied the canvas's first event) shows as off, and the answer as
  # changed.
  c="$(tree replay-off replayed canvas)"
  check "a guard switched off changes the replayed answer" says "$c" "Replay: answer changed"
  check "and shows as off" says "$c" "off"
else
  echo "skip  replay: no hooky at ~/.local/bin/hooky"
fi

exit "$failed"
