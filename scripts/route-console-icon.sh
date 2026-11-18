#!/usr/bin/env bash
# Renders route-console/icon/AppIcon.icns from the two SVGs beside it, with
# Chrome for the SVG filters and blend modes and iconutil for the icns. The
# SVGs are on Apple's icon grid (824 pt body inside 1024, transparent around);
# AppIcon-small.svg drops the grain, which is finer than a pixel at 64 px and
# below. Run it after changing either SVG, then rebuild .#route-console.
#
#   scripts/route-console-icon.sh
set -euo pipefail

dir="$(cd "$(dirname "$0")/../route-console/icon" && pwd)"
chrome="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
[ -x "$chrome" ] || { echo "no Chrome at $chrome: set CHROME" >&2; exit 1; }
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir "$work/AppIcon.iconset"

render() { # size svg -> $work/p<size>.png
  printf '<!doctype html><style>html,body{margin:0;background:transparent}img{display:block;width:%spx;height:%spx}</style><img src="file://%s">' \
    "$1" "$1" "$dir/$2" >"$work/r$1.html"
  "$chrome" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --default-background-color=00000000 --window-size="$1,$1" \
    --screenshot="$work/p$1.png" "file://$work/r$1.html" >/dev/null 2>&1
  [ -s "$work/p$1.png" ] || { echo "Chrome rendered nothing at $1 px" >&2; exit 1; }
}
for n in 16 32 64; do render "$n" AppIcon-small.svg; done
for n in 128 256 512 1024; do render "$n" AppIcon.svg; done

set_icon() { cp "$work/p$1.png" "$work/AppIcon.iconset/icon_$2.png"; }
set_icon 16 16x16; set_icon 32 16x16@2x
set_icon 32 32x32; set_icon 64 32x32@2x
set_icon 128 128x128; set_icon 256 128x128@2x
set_icon 256 256x256; set_icon 512 256x256@2x
set_icon 512 512x512; set_icon 1024 512x512@2x
iconutil -c icns "$work/AppIcon.iconset" -o "$dir/AppIcon.icns"
echo "wrote $dir/AppIcon.icns"
