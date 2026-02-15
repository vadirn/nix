#!/usr/bin/env bash
set -euo pipefail

sudo darwin-rebuild switch --flake ~/nix

echo "Installing Claude plugins..."
claude plugin install typescript-lsp
claude plugin install ralph-loop
claude plugin install firecrawl@claude-plugins-official

echo "Installing global npm packages..."
npm install -g @playwright/cli@latest
npm install -g firecrawl-cli

echo "Done."
