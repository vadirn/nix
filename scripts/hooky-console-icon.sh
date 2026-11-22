#!/usr/bin/env bash
# Compiles hooky-console/icon/AppIcon.icon, the Icon Composer document, into
# the Assets.car and AppIcon.icns beside it, which the nix build copies into
# the app. actool comes with Xcode, which the nix sandbox cannot reach, so the
# compiled files are committed. Run it after editing the icon (in Icon
# Composer, or its icon.json and Assets/ by hand), then rebuild .#hooky-console.
#
#   scripts/hooky-console-icon.sh
set -euo pipefail

dir="$(cd "$(dirname "$0")/../hooky-console/icon" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
# The deployment target only decides which older systems get AppIcon.icns;
# macOS 26 and later draw the Liquid Glass icon from Assets.car.
xcrun actool "$dir/AppIcon.icon" --compile "$work" --platform macosx \
  --target-device mac --minimum-deployment-target 14.0 --app-icon AppIcon \
  --output-partial-info-plist "$work/partial.plist" \
  --output-format human-readable-text >/dev/null
for f in Assets.car AppIcon.icns; do
  [ -s "$work/$f" ] || { echo "actool wrote no $f" >&2; exit 1; }
  cp "$work/$f" "$dir/$f"
done
echo "wrote $dir/Assets.car and $dir/AppIcon.icns"
