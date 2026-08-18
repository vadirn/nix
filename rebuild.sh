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
#
# Force IPv4-first DNS: this host has no native IPv6 (en0 is link-local only),
# but Tailscale installs IPv6 default routes, so the stack attempts IPv6 to
# dual-stack CDNs and dead-ends in the tunnel (connect EHOSTUNREACH or a silent
# timeout). Playwright's downloader doesn't recover via Happy Eyeballs the way
# normal apps do, so it stalls. NODE_OPTIONS propagates to the spawned
# oopDownloadBrowserMain child; a bare node flag would not.
#
# Pin the Nix-provided Node (v22 LTS): under Homebrew Node 26 the downloader's
# parent<->child IPC deadlocks after the artifact is fetched (both processes
# idle in kevent, marker never written), hanging the install indefinitely.
echo "Installing Playwright Chromium..."
env NODE_OPTIONS="--dns-result-order=ipv4first" \
  /run/current-system/sw/bin/node "$HOME/.bun/install/global/node_modules/playwright/cli.js" install chromium

echo "Registering Playwright MCP server..."
if ! claude mcp get playwright >/dev/null 2>&1; then
  claude mcp add --scope user playwright -- \
    node "$HOME/.bun/install/global/node_modules/@playwright/mcp/cli.js"
fi

echo "Installing pi plugins..."
pi install https://github.com/davebcn87/pi-autoresearch

# Refresh sudo credentials: darwin-rebuild's grant may have expired by now.
sudo -v
echo "Collecting garbage..."
sudo HOME=/var/root nix-collect-garbage -d

echo "Done."
