#!/usr/bin/env bash
# Refresh all agent-related symlinks and rebuild CLAUDE.md.
# Runnable without darwin-rebuild.
#
# Mirrors the agent-related `home.file.*` entries in home/default.nix.
# Keep this list in sync with that file.
set -euo pipefail

ROOT="${ROOT:-$HOME/nix}"

# Format: "<path-under-$HOME>|<path-under-$ROOT>"
LINKS=(
  ".agents/scripts/ghostty-claude-split.applescript|home/agents/scripts/ghostty-claude-split.applescript"
  ".local/bin/skills-add|home/agents/scripts/skills-add.sh"
  ".local/bin/build-claude-md|home/claude/build-claude-md.sh"
  ".local/bin/sync-agents|home/agents/scripts/sync-agents.sh"
  ".local/bin/pr-template|home/agents/scripts/pr-template.sh"
  ".claude/settings.json|home/claude/settings.json"
  ".claude/hooks|home/claude/hooks"
  ".claude/agents|home/agents/agents"
  ".claude/output-styles|home/agents/output-styles"
  ".claude/statusline.sh|home/claude/statusline.sh"
)

for entry in "${LINKS[@]}"; do
  link="$HOME/${entry%%|*}"
  target="$ROOT/${entry##*|}"
  if [ ! -e "$target" ] && [ ! -L "$target" ]; then
    echo "warning: target missing, skipping: $target" >&2
    continue
  fi
  if [ -e "$link" ] && [ ! -L "$link" ]; then
    echo "error: refusing to replace real path: $link" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$link")"
  ln -sfn "$target" "$link"
done

bash "$ROOT/home/claude/build-claude-md.sh"

AGENTS_SKILLS="$HOME/.agents/skills"
CLAUDE_SKILLS="$HOME/.claude/skills"
mkdir -p "$AGENTS_SKILLS" "$CLAUDE_SKILLS"
find "$AGENTS_SKILLS" "$CLAUDE_SKILLS" -maxdepth 1 -type l -delete

for src in "$ROOT/home/agents/skills/"*/; do
  [ -d "$src" ] || continue
  [ -f "$src/SKILL.md" ] || continue
  name=$(basename "$src")
  ln -sfn "$src" "$AGENTS_SKILLS/$name"
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

echo "synced agent symlinks and rebuilt CLAUDE.md"
