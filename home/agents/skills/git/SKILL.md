---
name: git
description: >
  Git workflow — create a commit, cut a branch, open or update a pull request. Subcommands: `/git commit` (also "commit", "коммит", "закоммить", "сохрани изменения"), `/git branch` (also "new branch", "create a branch", "start a feature branch", "новая ветка", "создай ветку", "заведи ветку"), `/git pr` (also "create pr", "open pr", "draft pr", "сделай PR", "оформи PR", "пулл реквест"). All three name their work with the same `feat | fix | chore` contract test. Skip for: amend, rebase, and push, which stay user-driven; switching to an existing branch (plain `git checkout`); inspecting an existing PR's state, comments, or CI (plain `gh` — see `references/pr-inspect.md`).
---

# Git

Three acts that put work into git: a commit records a change, a branch holds the commits delivering one net change, a PR proposes that change for merge. All three name their work with the same `<prefix>`, defined once in `references/prefix.md`.

```
dir = skill base directory
Read(dir/references/prefix.md)     // every subcommand names its work

if "commit":   Read(dir/references/commit.md)
elif "branch": Read(dir/references/branch.md)
elif "pr":     Read(dir/references/pr.md)
else:          do("ask which of commit | branch | pr the user wants")

do("follow the workflow in the reference just read")
```

A subcommand that needs another reads its reference and follows it inline — one skill, so there is no `Skill()` hop between them.

## Rules

- **Run git commands separately.** Chained commands (`&&`, `;`) bypass the permissions allowlist.
- **Auto-detect the default branch.** Use `gh repo view`. Ask the user only when detection fails.
- **Pushing is the user's call.** No subcommand pushes except `pr`, which pushes the branch it is about to propose.
- **Preserve history.** Amend or rebase only when the user explicitly asks.
