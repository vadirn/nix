#!/usr/bin/env bash
# Signs the nix-built Route Console with a Developer ID and puts it where
# Finder and Spotlight see it. codesign needs the login keychain, which the
# nix sandbox cannot reach, so this step runs after the build; the store copy
# stays ad hoc signed.
#
#   nix build .#route-console
#   scripts/sign-route-console.sh [RESULT] [DEST]
#
# RESULT defaults to ./result, DEST to ~/Applications/Route Console.app.
# ROUTE_CONSOLE_SIGN names the identity; without it, the keychain's only
# "Developer ID Application" identity is used.
set -euo pipefail

src="${1:-result}/Applications/Route Console.app"
dest="${2:-$HOME/Applications/Route Console.app}"
[ -d "$src" ] || { echo "no bundle at $src: run nix build .#route-console first" >&2; exit 1; }
# DEST is replaced whole, so it must name an app bundle, not a folder.
case "$dest" in
  *.app) ;;
  *) echo "DEST must end in .app: $dest" >&2; exit 1 ;;
esac

identity="${ROUTE_CONSOLE_SIGN:-}"
if [ -z "$identity" ]; then
  ids="$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | sort -u)"
  if [ -z "$ids" ] || [ "$(printf '%s\n' "$ids" | wc -l)" -ne 1 ]; then
    echo "need exactly one Developer ID Application identity, found:" >&2
    printf '  %s\n' "${ids:-none}" >&2
    echo "set ROUTE_CONSOLE_SIGN to the one to use" >&2
    exit 1
  fi
  identity="$ids"
fi

# Stage beside the destination, then swap, so an interrupted run never
# leaves a half-copied app at DEST.
mkdir -p "$(dirname "$dest")"
stage="$(mktemp -d "$(dirname "$dest")/.route-console.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
cp -R "$src" "$stage/app"
chmod -R u+w "$stage/app"
# The hardened runtime keeps the app notarizable; it loads only system
# libraries (flake.nix checks), so library validation has nothing to refuse.
codesign --force --options runtime --timestamp --sign "$identity" "$stage/app"
codesign --verify --strict --verbose=1 "$stage/app"
rm -rf "$dest"
mv "$stage/app" "$dest"
echo "signed: $dest ($identity)"
