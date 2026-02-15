#!/usr/bin/env bash
set -euo pipefail

sudo darwin-rebuild switch --flake ~/nix

echo "Installing Claude plugins..."
claude plugin install typescript-lsp
claude plugin install ralph-loop
claude plugin marketplace add brave/brave-search-skills
claude plugin install brave-search-skills@brave-search

echo "Installing Playwright CLI..."
npm install -g @playwright/cli@latest

echo "Done."
