#!/usr/bin/env bash
set -euo pipefail

sudo darwin-rebuild switch --flake ~/nix

echo "Installing Claude plugins..."
claude plugin install typescript-lsp
claude plugin install firecrawl@claude-plugins-official
claude plugin install skill-creator@claude-plugins-official
claude plugin install frontend-design@claude-plugins-official
claude plugin install playground@claude-plugins-official
claude plugin install agent-browser@agent-browser

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
