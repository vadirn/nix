#!/usr/bin/env bash
# Concatenate AGENTS.md + claude-additions.md into ~/.claude/CLAUDE.md.
# Run directly to refresh CLAUDE.md without darwin-rebuild.
set -euo pipefail

ROOT="${ROOT:-$HOME/nix}"
mkdir -p "$HOME/.claude"
cat \
  "$ROOT/home/agents/AGENTS.md" \
  "$ROOT/home/claude/claude-additions.md" \
  > "$HOME/.claude/CLAUDE.md"
echo "wrote $HOME/.claude/CLAUDE.md"
