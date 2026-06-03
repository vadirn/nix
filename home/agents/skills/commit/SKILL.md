---
name: commit
description: >
  Stage and commit changes with a conventional commit message. Triggers: /commit, "commit", "коммит",
  "закоммить", "сохрани изменения". For new commits only; skip for amend/rebase/push.
---

# Commit

Stage changed files and create a conventional commit.

```
// Gather state (parallel)
status = Bash(git status)
diff = Bash(git diff)
staged = Bash(git diff --cached)
log = Bash(git log --oneline -5)

// Guards
if no changes in status: do("say 'Nothing to commit.'"), stop

// Stage
files = do("pick files to stage; warn and exclude secrets (.env, credentials, tokens); honor user subset like 'commit the refactor'")
Bash(git add <files>)

// Draft
prefix = do("pick one of feat | fix | chore by the three-question contract test")
message = do("draft '<prefix>: <why>', short single lowercase line, state the WHY")

// Confirm when ambiguous
needs_confirmation = do("true if mixed changes, unclear prefix, or secrets detected")
if needs_confirmation: AskUserQuestion("prefix: <prefix> | message: <message> | files: <files>")

// Commit
Write(/tmp/claude/commit.txt, "<prefix>: <message>")
Bash(git commit -F /tmp/claude/commit.txt)
Bash(rm -f /tmp/claude/commit.txt)

// Verify
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

Outside the contract: speed, memory use, internal structure, log/metric/trace format (unless documented as a stability surface).

Ask three questions in order; stop at the first "yes":

1. Was the contract violated before this change, and now honored? → `fix`
2. Does this change the contract (add, alter, or remove what's promised)? → `feat`
3. Otherwise → `chore`

`chore` is the default — most changes (refactor, perf, deps, config, internal docs, tests, migrations, i18n) sit below the contract line. `feat` and `fix` are reserved for changes that cross it, so they carry information: a `feat` commit means callers might need to react; a `fix` commit means a promise that was being violated is now honored.

**One concern per commit.** If a change crosses the contract line in multiple ways, split it.

Prefix-selection examples (these illustrate which prefix to choose, not message style):

*Contract changes (`feat`):*

- "add retry logic to API client" — new promise → `feat`
- "remove deprecated /v1 endpoint" — contract narrowed → `feat`
- "drop deprecated `orders.legacy_status` column" → `feat`
- "tighten return type from `any` to `User`" — type signature is part of the contract → `feat`

*Contract repairs (`fix`):*

- "fix typo in error message" — error text is part of the contract → `fix`
- "patch credential-leak in token handler" — implicit safety promise was violated → `fix`
- "correct wrong example in public API docs" — public docs are the contract → `fix`

*Below the contract (`chore`):*

- "extract request helper" — contract unchanged → `chore`
- "cache user lookup, 50ms → 2ms" — speed sits below the contract line → `chore`
- "page was 30s, now 1s; resolves slowness ticket" — same → `chore`
- "add concurrent index on `orders.user_id`" — backward-compatible migration → `chore`
- "add Korean translations" — localization sits below the contract line → `chore`
- "polish internal README" — internal docs sit below the contract line → `chore`
- "bump dependency, no API impact" → `chore`
- "add unit test for existing behavior" → `chore`

*Special:*

- Reverts: apply the three-question test to the revert's effect on the contract. Reverting a buggy release restores a violated promise → `fix`. Pulling a feature narrows the contract → `feat`.

### Message style

- Short single line, lowercase after prefix
- State the WHY; the diff already shows the WHAT
- Plain `<prefix>: ...` form only; no body, no scope. Match recent log only for tone and length, not for scope or body

WHY vs WHAT:

- `chore: extract request helper` — WHAT. Better: `chore: deduplicate retry/backoff between API clients`
- `fix: typo in error message` — WHAT. Better: `fix: error text referenced removed flag, confusing users`
- `feat: add retry logic to API client` — WHAT. Better: `feat: retry transient API failures so callers don't see flakes`

### Why the message goes through a file

Messages can contain `!` (e.g. `fix: handle invalid input!`) and zsh history expansion mangles it even inside single-quoted HEREDOCs. Passing `-F /tmp/claude/commit.txt` sidesteps the shell entirely. The file is deleted after the commit so the next run's `Write` sees a fresh path (the `Write` tool refuses to overwrite an existing file without a prior `Read`). The file also serves as proof of skill use: the global `commit-msg` hook reads it and refuses the commit unless its content matches what git received as the commit message. There is no separate nonce file and no time window. The hook deletes `commit.txt` on success, so the same artifact validates exactly one commit.

## Rules

- **Separate git commands.** Chained commands (`&&`, `;`) bypass the permissions allowlist.
- **Commit only.** Pushing is a separate user decision.
- **Preserve history.** Amend only when the user explicitly asks.
- **Run hooks.** If a hook fails, fix the issue, re-stage, create a fresh commit.
