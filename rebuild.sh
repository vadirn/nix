#!/usr/bin/env bash
set -euo pipefail

sudo darwin-rebuild switch --flake ~/nix

echo "Installing Claude plugins..."
claude plugin install typescript-lsp

echo "Syncing agents..."
bash "$HOME/nix/home/agents/scripts/sync-agents.sh"

echo "Installing global npm packages..."
npm install -g firecrawl-cli @mariozechner/pi-coding-agent

echo "Installing pi plugins..."
pi install https://github.com/davebcn87/pi-autoresearch

echo "Collecting garbage..."
sudo HOME=/var/root nix-collect-garbage -d

if [[ ! -d "/Applications/Gemini.app" && ! -d "$HOME/Applications/Gemini.app" ]]; then
    echo "Gemini.app not found. Install manually from: https://gemini.google/mac/"
fi

echo "Done."
