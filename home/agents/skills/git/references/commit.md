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
prefix = do("pick one of feat | fix | chore by the contract test in prefix.md")
message = do("draft '<prefix>: <why>', short single lowercase line, state the WHY")

// Confirm when ambiguous
needs_confirmation = do("true if mixed changes, unclear prefix, or secrets_excluded")
if needs_confirmation: AskUserQuestion("prefix: <prefix> | message: <message> | files: <files>")

// Commit — the file route is mandatory, see §The message file below
Write(/tmp/claude/commit.txt, "<prefix>: <message>")   // exact final message, written after any confirmation
Bash(git commit -F /tmp/claude/commit.txt)             // never -m

// Verify
Bash(git status)
```

## The message file

Every commit goes through `/tmp/claude/commit.txt`. This is a hard rule, enforced by a global `commit-msg` hook — a commit whose message reaches git any other way is rejected.

- **Never `-m`.** `git commit -F /tmp/claude/commit.txt` is the only accepted form.
- **Write the exact final message.** The hook compares the file's content against what git received; any divergence rejects the commit. Settle the message first — including anything a confirmation step changed — then write the file once.
- **One file validates one commit.** The hook deletes it on success, so every commit writes it fresh. A leftover file from a failed attempt is stale; rewrite it rather than reusing it.

Read `commit-hook.md` for why the mechanism is shaped this way, and when a rejection is not explained by the three rules above.

## Message style

- Short single line, lowercase after prefix
- State the WHY; the diff already shows the WHAT
- Plain `<prefix>: ...` form only; no body, no scope. Match recent log only for tone and length, not for scope or body

WHY vs WHAT:

- `chore: extract request helper` — WHAT. Better: `chore: deduplicate retry/backoff between API clients`
- `fix: typo in error message` — WHAT. Better: `fix: error text referenced removed flag, confusing users`
- `feat: add retry logic to API client` — WHAT. Better: `feat: retry transient API failures so callers don't see flakes`

## Rules

- **Run hooks.** If a hook fails, fix the issue, re-stage, create a fresh commit.
