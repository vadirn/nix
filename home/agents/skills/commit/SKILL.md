---
name: commit
description: >
  Stage and commit changes with a conventional commit message. Triggers: /commit, "commit", "коммит",
  "закоммить", "сохрани изменения". For new commits only — skip for amend/rebase/push.
---

# Commit

Stage changed files and create a conventional commit.

```
// Gather state (parallel)
status = Bash(git status)
diff = Bash(git diff)
staged = Bash(git diff --cached)
log = Bash(git log --oneline -5)

if no changes: tell user "Nothing to commit.", stop

// Analyze changes, pick ONE prefix: feat | fix | chore
// Stage files by name (`git add file1 file2`)
// Skip secrets (.env, credentials, tokens); warn if found
// If user targets a subset ("commit the refactor"), stage only those

// Draft message: short single line, lowercase after prefix, focus on WHY
message = "<prefix>: <message>"

// Confirm when ambiguous (mixed changes, unclear prefix, secrets detected)
// Skip confirmation when: single logical change, clear prefix, no secrets
if needs_confirmation:
    AskUserQuestion: show prefix, message, staged files

Write(/tmp/claude/commit.txt, "<prefix>: <message>")
Bash(mktemp /tmp/claude/commit-nonce.XXXXXX)
Bash(git commit -F /tmp/claude/commit.txt)
Bash(rm -f /tmp/claude/commit.txt)

Bash(git status)
```

## Reference

### Prefix selection

**Contract** = what the code promises its outermost audience: end-users for a product, callers for a library.

In the contract:

- Inputs accepted, outputs produced, errors raised, externally-visible side effects.
- Type signatures (in typed languages).
- Documented behavior, plus behavior that tests, types, or other callsites in this repo rely on.
- Implicit safety promises every system makes: no data leaks, no crashes on malformed input, no privilege escalation.

Not in the contract: speed, memory use, internal structure, log/metric/trace format (unless documented as a stability surface).

Ask three questions in order; stop at the first "yes":

1. Was the contract violated before this change, and now honored? → `fix`
2. Does this change the contract (add, alter, or remove what's promised)? → `feat`
3. Otherwise → `chore`

`chore` is the default — most changes (refactor, perf, deps, config, internal docs, tests, migrations, i18n) sit below the contract line. `feat` and `fix` are reserved for changes that cross it, so they carry information: a `feat` commit means callers might need to react; a `fix` commit means a promise that was being violated is now honored.

**One concern per commit.** If a change crosses the contract line in multiple ways, split it.

**Scope carries visibility.** When a `chore` is operationally significant, use scope to signal it: `chore(perf): ...`, `chore(migration): ...`, `chore(i18n): ...`. In a repo with multiple contract surfaces (library + CLI, or monorepo packages), use scope to indicate which surface changed: `feat(sdk): ...`, `feat(ui): ...`.

Examples:

*Contract changes (`feat`):*

- "add retry logic to API client" — new promise → `feat`
- "remove deprecated /v1 endpoint" — contract narrowed → `feat`
- "drop deprecated `orders.legacy_status` column" — `feat(migration)`
- "tighten return type from `any` to `User`" — type signature is part of the contract → `feat`

*Contract repairs (`fix`):*

- "fix typo in error message" — error text is part of the contract → `fix`
- "patch credential-leak in token handler" — implicit safety promise was violated → `fix`
- "correct wrong example in public API docs" — public docs are the contract → `fix`

*Below the contract (`chore`):*

- "extract request helper" — contract unchanged → `chore`
- "cache user lookup, 50ms → 2ms" — speed isn't in the contract → `chore(perf)`
- "page was 30s, now 1s; resolves slowness ticket" — same → `chore(perf)`
- "add concurrent index on `orders.user_id`" — backward-compatible migration → `chore(migration)`
- "add Korean translations" — localization is below the contract → `chore(i18n)`
- "polish internal README" — internal docs aren't the contract → `chore`
- "bump dependency, no API impact" → `chore`
- "add unit test for existing behavior" → `chore`

*Special:*

- Reverts: apply the three-question test to what the revert undoes. Reverting a buggy release → `fix`. Pulling a feature → `feat`.

### Message style

- Short single line, lowercase after prefix
- Focus on WHY, not WHAT
- No body, no scope unless disambiguation needed
- Match recent commit style from log

### Write the message to a file

Messages can contain `!` (e.g. `fix: handle invalid input!`) and zsh history expansion mangles it even inside single-quoted HEREDOCs. Write the message to `/tmp/claude/commit.txt`, pass `-F`, then delete the file so the next run's Write sees a fresh path (the Write tool refuses to overwrite an existing file without a prior Read). Create the nonce file immediately before committing — the global pre-commit hook requires a `/tmp/claude/commit-nonce.*` file less than 60 seconds old and deletes it on consume.

```
Write(/tmp/claude/commit.txt, "<prefix>: <message>")
Bash(mktemp /tmp/claude/commit-nonce.XXXXXX)
Bash(git commit -F /tmp/claude/commit.txt)
Bash(rm -f /tmp/claude/commit.txt)
```

## Rules

- **Separate git commands.** Chained commands (`&&`, `;`) bypass the permissions allowlist.
- **Commit only.** Pushing is a separate user decision.
- **Preserve history.** Only amend when user explicitly asks.
- **Run hooks.** If a hook fails, fix the issue, re-stage, create a fresh commit.
