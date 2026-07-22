# /git commit

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
files, secrets_excluded = do("pick files to stage; exclude secrets (.env, credentials, tokens) and set secrets_excluded=true if any are found; honor user subset like 'commit the refactor'")
Bash(git add <files>)

// Draft
prefix = do("pick one of feat | fix | chore by the three-question contract test in SKILL.md")
message = do("draft '<prefix>: <why>', short single lowercase line, state the WHY")

// Confirm when ambiguous
needs_confirmation = do("true if mixed changes, unclear prefix, or secrets_excluded")
if needs_confirmation: AskUserQuestion("prefix: <prefix> | message: <message> | files: <files>")

// Commit
Write(/tmp/claude/commit.txt, "<prefix>: <message>")
Bash(git commit -F /tmp/claude/commit.txt)

// Verify
Bash(git status)
```

## Message style

- Short single line, lowercase after prefix
- State the WHY; the diff already shows the WHAT
- Plain `<prefix>: ...` form only; no body, no scope. Match recent log only for tone and length, not for scope or body

WHY vs WHAT:

- `chore: extract request helper` — WHAT. Better: `chore: deduplicate retry/backoff between API clients`
- `fix: typo in error message` — WHAT. Better: `fix: error text referenced removed flag, confusing users`
- `feat: add retry logic to API client` — WHAT. Better: `feat: retry transient API failures so callers don't see flakes`

## Why the message goes through a file

Messages can contain `!` (e.g. `fix: handle invalid input!`) and zsh history expansion mangles it even inside single-quoted HEREDOCs. Passing `-F /tmp/claude/commit.txt` sidesteps the shell entirely. The file is deleted after the commit so the next run's `Write` sees a fresh path (the `Write` tool refuses to overwrite an existing file without a prior `Read`). The file also serves as proof of skill use: the global `commit-msg` hook reads it and refuses the commit unless its content matches what git received as the commit message. There is no separate nonce file and no time window. The hook deletes `commit.txt` on success, so the same artifact validates exactly one commit.

## Rules

- **Commit only.** Pushing is a separate user decision.
- **Preserve history.** Amend only when the user explicitly asks.
- **Run hooks.** If a hook fails, fix the issue, re-stage, create a fresh commit.
