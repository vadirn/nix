# /git commit

Stage changed files and create a conventional commit.

```
// Gather state (parallel)
status = Bash(git status)
diff = Bash(git diff)
staged = Bash(git diff --cached)
log = Bash(git log --oneline -5)
artifact_dir = Bash(echo "/tmp/claude/${CLAUDE_CODE_SESSION_ID:-none}/$(git rev-parse --show-toplevel | shasum | cut -c1-12)")   // this session's and worktree's own directory

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

// Commit — the message hook checks it, see §The message hook below
Bash(rm -f <artifact_dir>/commit.txt)
Write(<artifact_dir>/commit.txt, "<prefix>: <message>")   // final message, written after any confirmation
Bash(git commit -F <artifact_dir>/commit.txt)             // or -m, see §The message hook
Bash(rm -f <artifact_dir>/commit.txt)

// Verify
Bash(git status)
```

## The message hook

A PreToolUse hook checks every `git commit` before it runs. It sends the message and the diff git will commit to the Trinket workflow `git.message`. A failed rule refuses the commit, with one fix per finding.

- **Apply each fix, then commit again.** Rewrite the message file: `rm -f` it, then `Write` it fresh.
- **Ask the user about a finding you think is wrong.** Stop and ask. Never reach git another way.
- **Stage in a separate step.** The hook refuses `git add … && git commit …`, because it runs before `git add`.
- **Write the message file in a separate step.** The hook reads the file before the command runs.
- **`-m` works too.** The Bash tool turns `!` into `\!` even inside quotes, so a message holding `!` goes through the file.
- **A check that does not finish refuses the commit.** Tell the user its cause, such as Trinket.app not running.

Read `commit-hook.md` for why the hook is shaped this way.

## Message style

- Short single line, lowercase after prefix
- State the WHY; the diff already shows the WHAT
- Plain `<prefix>: ...` form only; no body, no scope. Match recent log only for tone and length, not for scope or body

WHY vs WHAT:

- `chore: extract request helper` — WHAT. Better: `chore: deduplicate retry/backoff between API clients`
- `fix: typo in error message` — WHAT. Better: `fix: error text referenced removed flag, confusing users`
- `feat: add retry logic to API client` — WHAT. Better: `feat: retry transient API failures so callers don't see flakes`

### Simplified style

The Simplified output style governs the subject line, as it governs all authored prose.

- "State the WHY" is Simplified's "lead with the conclusion," not a second rule.
- The subject is one line for one concern. Simplified says split a sentence that carries two claims. Here the split is two commits, never two sentences. `prefix.md` §Unit of the prefix requires one concern per commit.

## Rules

- **Run hooks.** If a hook fails, fix the issue, re-stage, create a fresh commit.
