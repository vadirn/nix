---
name: changes
description: >
  Summarize the current diff per file as markdown: a `## <filepath>` heading per
  changed file followed by a prose summary of its changes. Triggers: /changes,
  "summarize the diff", "what changed per file", "per-file summary of changes",
  "суммаризируй дифф", "что изменилось по файлам". Skip for reviewing quality or
  bugs (use /code-review) and for raw diff output (plain `git diff`).
---

# Changes

Summarize changes per file, printed as markdown for the user.

```
// Resolve scope
scope = <args>                                    // ref or range if the user named one
if no args:
    if working tree has staged, unstaged, or untracked changes: scope = "HEAD"
    else if on a feature branch:                                scope = "<default>...HEAD"   // three-dot: this branch's own commits
    else: do("say 'Nothing to summarize — clean tree on <branch>.'"), stop

// Gather changed files (status letter + path)
files = Bash(git diff --name-status <scope>)
if scope == "HEAD": files += do("append untracked files from git status --porcelain -u as status 'A' (new)")
if no files: do("say 'No changes to summarize.'"), stop

// Summarize each file
for status, file in files:
    diff = Bash(git diff <scope> -- <file>)
    summary = do("summarize intent from the diff and status: what changed and why, not a hunk recap")
    emit("## <file>\n\n<summary>")
```

## Output format

Per changed file, in the order git reports them, emit:

```
## <filepath from repo root>

<one-paragraph summary of what the change does and, when visible, why>
```

## Rules

- **Paths from the repo root.** Print each heading as the path git reports, never absolute or basename-only — repo-relative paths stay clickable.
- **Summarize intent, not mechanics.** One short paragraph per file: what the change does and, when visible, why. No line-number play-by-play — a hunk recap is what plain `git diff` already gives.
- **Cover every changed file.** Renames, deletions, new files, and binary changes each get a heading; the `--name-status` letter feeds the status note in the summary.
- **Untracked files count only for the working-tree scope (`HEAD`).** List them via `git status --porcelain -u` (file-level, not the collapsed directory) and summarize as "new file"; for a ref range they are irrelevant.
- **Read-only.** This skill never stages, commits, or mutates the tree.
