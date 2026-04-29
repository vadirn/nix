# Post-edit etiquette

Rules to apply after creating or editing any vault file (cards, notes, references, weekly log entries) before wrapping the turn. The dispatcher Reads this file alongside the per-type reference whenever an edit branch fires.

## Git vs Obsidian Sync

The vault is a git repo, but `.gitignore` allowlists only a small subset (`.gitignore`, `.claude/`, `.scripts/`). Everything else is managed by Obsidian Sync.

Skip the `/commit` suggestion after editing vault content. Cards, notes, references, tracks, and weekly logs reach other devices through Obsidian Sync; Sync alone is enough. The exceptions:

- Edits landed inside `.claude/` or `.scripts/` (confirm with `git status` if unsure).
- The user explicitly asked to commit.

When the exceptions hit, suggest `/commit` normally.

### Why

Obsidian Sync propagates the vast majority of vault content without git involvement. A `/commit` prompt after every card or note adds friction that the user has to dismiss every time, and risks staging files that `.gitignore` would refuse anyway. The git-tracked subtrees are small and obvious from `git status` — when something does land there, the suggestion is informative rather than noise.
