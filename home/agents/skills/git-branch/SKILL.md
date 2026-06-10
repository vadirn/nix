---
name: git-branch
description: >
  Create a git branch with a conventional <prefix>/<slug> name, cut from an
  up-to-date default branch. Triggers: /git-branch, "new branch", "create a branch",
  "start a feature branch", "новая ветка", "создай ветку", "заведи ветку".
  Skip for switching to an existing branch (plain `git checkout`).
---

# Git Branch

Create a feature branch named `<prefix>/<slug>`, cut from an up-to-date default branch.

```
// Gather state (parallel)
status  = Bash(git status)
branch  = Bash(git rev-parse --abbrev-ref HEAD)
default = Bash(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)

// Name
prefix = do("pick feat | fix | chore by the three-question contract test — see Prefix selection")
slug   = do("kebab-case the intended work in 2-4 words; name the work, not the files")
name   = "<prefix>/<slug>"

// Pick the base
clean = do("true if status shows no uncommitted changes")
Bash(git fetch origin <default>)       // fetch before any base decision so origin/<default> is never stale
if branch == default and clean:
    base = "origin/<default>"          // start even with origin
else if branch != default:
    AskUserQuestion("on <branch>, not <default> — stack the new branch here, or cut from <default>?")
    base = current HEAD, or origin/<default> per the answer
else:                                  // on default with uncommitted changes
    AskUserQuestion("uncommitted changes — commit them on <branch> first, or carry them onto the new branch?")
    if commit first: Skill(commit), base = "origin/<default>"
    else:            base = current HEAD   // checkout -b carries the working tree along

// Confirm
if user supplied explicit branch name: skip
else: AskUserQuestion("create <name> off <base>?")

// Create
if base == "origin/<default>": Bash(git checkout -b <name> origin/<default>)
else:                          Bash(git checkout -b <name>)
```

## Reference

### Prefix selection

Branch names use `<prefix>/<slug>` — the same `feat | fix | chore` prefixes as commits, with `/` as the separator. A branch is a larger unit than a commit: it holds many commits, and they need not share a prefix — a `feat` branch routinely contains `chore` refactors and a stray `fix`. So the branch prefix is never inherited from a commit. Determine it independently by applying the contract test to the branch's planned work as a whole — the net change it delivers when merged, which is also what the squash-merge commit and PR title will carry. Ask in order; stop at the first "yes":

1. Will the branch repair a violated contract — restore behavior the code promised but broke? → `fix`
2. Will the branch change the contract — add, alter, or remove what the code promises its callers? → `feat`
3. Otherwise → `chore`

`chore` is the default; most branches (refactor, perf, deps, config, tests, docs) sit below the contract line. See the /commit skill for the full definition of "contract" and the worked example bank.

### Slug style

- 2-4 lowercase words joined by hyphens, appended to the prefix: `feat/retry-transient-failures`.
- Name the work, not the files touched: `fix/retry-transient-failures`, not `fix/edit-api-client`.
- Add dates, ticket numbers, or author names only when the user asks.

### Base branch

- Default: cut from the updated default branch so the new branch starts even with `origin`. `git fetch origin <default>` followed by `git checkout -b <name> origin/<default>` branches from the fetched ref without checking out the default branch first.
- When the user is already on a feature branch, ask before choosing — stacking the new branch on the current one is sometimes intended.

### Uncommitted changes

- `git checkout -b` carries the working tree onto the new branch; uncommitted work is carried intact. When the tree is dirty, branch from current HEAD rather than `origin/<default>`; the checkout then carries the changes free of a "would be overwritten" conflict.
- Suggest committing on the current branch first only when the user says those changes belong there.

## Rules

- **Run git commands separately.** Chained commands (`&&`, `;`) bypass the permissions allowlist.
- **Auto-detect the default branch.** Use `gh repo view`. Ask the user only when detection fails.
- **Confirm the name before creating.** Show `<name>` and the base. Skip only when the user supplied an explicit branch name.
- **Create only.** This skill cuts new branches; switching to an existing branch is a plain `git checkout`.
