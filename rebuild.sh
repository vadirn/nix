#!/usr/bin/env bash
set -euo pipefail

sudo darwin-rebuild switch --flake ~/nix

echo "Installing Claude plugins..."
claude plugin install typescript-lsp

echo "Linking skills..."
AGENTS_SKILLS="$HOME/.agents/skills"
CLAUDE_SKILLS="$HOME/.claude/skills"
mkdir -p "$AGENTS_SKILLS" "$CLAUDE_SKILLS"
find "$AGENTS_SKILLS" "$CLAUDE_SKILLS" -maxdepth 1 -type l -delete

for src in "$HOME/nix/home/agents/skills/"*/; do
  [ -d "$src" ] || continue
  name=$(basename "$src")
  ln -sfn "$src" "$AGENTS_SKILLS/$name"
  ln -sfn "$src" "$CLAUDE_SKILLS/$name"
done

for src in "$HOME/nix/home/claude/skills/"*/; do
  [ -d "$src" ] || continue
  name=$(basename "$src")
  ln -sfn "$src" "$CLAUDE_SKILLS/$name"
done

if [ -d "$HOME/.claude/plugins/cache" ]; then
  find "$HOME/.claude/plugins/cache" -mindepth 3 -maxdepth 5 -type d -name skills | while read -r dir; do
    for skill in "$dir"/*/; do
      [ -f "$skill/SKILL.md" ] || continue
      ln -sfn "$skill" "$AGENTS_SKILLS/$(basename "$skill")"
    done
  done
fi

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
