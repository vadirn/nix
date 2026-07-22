---
name: git
description: >
  Git workflow — create a commit, cut a branch, open or update a pull request. Subcommands: `/git commit` (also "commit", "коммит", "закоммить", "сохрани изменения"), `/git branch` (also "new branch", "create a branch", "start a feature branch", "новая ветка", "создай ветку", "заведи ветку"), `/git pr` (also "create pr", "open pr", "draft pr", "сделай PR", "оформи PR", "пулл реквест"). All three name their work with the same `feat | fix | chore` contract test, defined here. Skip for: amend, rebase, and push, which stay user-driven; switching to an existing branch (plain `git checkout`); inspecting an existing PR's state, comments, or CI (plain `gh` — see `references/pr.md`).
---

# Git

Three acts that put work into git, sharing one naming convention: a commit records a change, a branch holds the commits that deliver one net change, a PR proposes that net change for merge. The `<prefix>` in all three comes from the contract test below.

```
dir = skill base directory

// Route by subcommand; infer it from the request when the user names no subcommand
if "commit":
    Read(dir/references/commit.md)
    do("follow the commit workflow")

elif "branch":
    Read(dir/references/branch.md)
    do("follow the branch workflow")

elif "pr":
    Read(dir/references/pr.md)
    do("follow the PR workflow")

else:
    do("ask which of commit | branch | pr the user wants")
```

The three compose: `branch` routes a dirty tree through the commit workflow, `pr` commits before pushing. A subcommand that needs another reads its reference file and follows it inline — this is one skill, so there is no `Skill()` hop between them.

## Prefix selection

**Contract** = what the code promises its outermost audience: end-users for a product, callers for a library.

In the contract:

- Inputs accepted, outputs produced, errors raised, externally-visible side effects.
- Type signatures (in typed languages).
- Documented behavior, plus behavior that tests, types, or other callsites in this repo rely on.
- Implicit safety promises every system makes: no data leaks, no crashes on malformed input, no privilege escalation.

Outside the contract: speed, memory use, internal structure, log/metric/trace format (unless documented as a stability surface).

Ask three questions in order; stop at the first "yes":

1. Was the contract violated before this change, and now honored? → `fix`
2. Does this change the contract (add, alter, or remove what's promised)? → `feat`
3. Otherwise → `chore`

`chore` is the default — most changes (refactor, perf, deps, config, internal docs, tests, migrations, i18n) sit below the contract line. `feat` and `fix` are reserved for changes that cross it, so they carry information: a `feat` commit means callers might need to react; a `fix` commit means a promise that was being violated is now honored.

Read `references/prefix-examples.md` when a call is unclear; it holds the worked example bank.

### Unit of the prefix

The three subcommands apply the same test to different units, so a branch prefix is never inherited from a commit.

- **Commit** — the one change being recorded. **One concern per commit**: if a change crosses the contract line in multiple ways, split it.
- **Branch** — the net change the branch delivers when merged, taken as a whole. A branch holds many commits and they need not share a prefix: a `feat` branch routinely contains `chore` refactors and a stray `fix`.
- **PR** — the same unit as its branch. The PR title becomes the commit message on squash-and-merge, so it carries the branch's prefix.

## Rules

- **Run git commands separately.** Chained commands (`&&`, `;`) bypass the permissions allowlist.
- **Auto-detect the default branch.** Use `gh repo view`. Ask the user only when detection fails.
- **Pushing is the user's call.** No subcommand pushes except `pr`, which pushes the branch it is about to propose.
- **Preserve history.** Amend or rebase only when the user explicitly asks.
