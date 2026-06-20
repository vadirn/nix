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

echo "Syncing agents..."
bash "$HOME/nix/home/agents/scripts/sync-agents.sh"

echo "Installing global bun packages..."
bash "$HOME/nix/home/bun/install-globals.sh"

# Playwright MCP runs under Node, not Bun: Bun's subprocess/IPC layer can't
# launch Chromium (microsoft/playwright#27139, oven-sh/bun#23826). The package
# is installed via Bun above (install != run); both commands below invoke Node.
echo "Installing Playwright Chromium..."
node "$HOME/.bun/install/global/node_modules/playwright/cli.js" install chromium

echo "Registering Playwright MCP server..."
if ! claude mcp get playwright >/dev/null 2>&1; then
  claude mcp add --scope user playwright -- \
    node "$HOME/.bun/install/global/node_modules/@playwright/mcp/cli.js"
fi

echo "Installing pi plugins..."
pi install https://github.com/davebcn87/pi-autoresearch

echo "Collecting garbage..."
sudo HOME=/var/root nix-collect-garbage -d

echo "Done."
