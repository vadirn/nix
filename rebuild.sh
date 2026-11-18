#!/usr/bin/env bash
set -euo pipefail

sudo darwin-rebuild switch --flake ~/nix

# Workaround for https://github.com/orgs/Homebrew/discussions/6258:
# `brew bundle install --upgrade` (run by nix-darwin) does not reliably upgrade
# outdated formulae. Run a real `brew upgrade` afterwards.
echo "Upgrading outdated brew formulae..."
brew upgrade --formula

echo "Installing Claude plugins..."
claude plugin install typescript-lsp
claude plugin install rust-analyzer-lsp

echo "Syncing agents..."
bash "$HOME/nix/home/agents/scripts/sync-agents.sh"

echo "Installing global bun packages..."
bash "$HOME/nix/home/bun/install-globals.sh"

echo "Installing pi plugins..."
pi install https://github.com/davebcn87/pi-autoresearch

# The switch built Route Console; signing needs the login keychain, so it
# happens here. A Mac without the Developer ID, or offline (the signature's
# timestamp comes from Apple), keeps the copy it has.
echo "Installing Route Console..."
bash "$HOME/nix/scripts/sign-route-console.sh" "$HOME/.local/share/route-console" ||
  echo "Route Console not updated; see the error above." >&2

# Refresh sudo credentials: darwin-rebuild's grant may have expired by now.
sudo -v
echo "Collecting garbage..."
sudo HOME=/var/root nix-collect-garbage -d

echo "Done."
