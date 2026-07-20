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

## By-product entries get an audience review

If the entry was created as a by-product of other work (a migration, an experiment, a session synthesis) rather than through a deliberate capture flow, run /justify on it before wrapping, asking one question per sentence: who is the reader? An entry's only reader is its future consumer; text addressed to the entry's editor, the process that produced it, or the reviewer is an audience leak — cut it. The Unresolved questions section is the exception, where the entry may talk about itself. Deliberate captures (user-initiated cards, notes, references) skip this pass.

### Why

Entries written mid-task inherit the task's context: mechanics of how the entry is delivered, rules addressed to its editor, commentary on the process that produced it. The leak is semantic, so no lint catches it; a one-command review at write time does.
