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
Bash(git commit -F /tmp/claude/commit.txt)

Bash(git status)
```

## Reference

### Prefix selection

- **feat** = new functionality or capability
- **fix** = corrects broken behavior
- **chore** = no user-facing behavior change (refactor, perf, deps, config, docs)

Examples:

- "added retry logic to API client" → `feat: add retry logic to API client`
- "typo in error message" → `fix: correct typo in API error message`
- "extracted helper, no behavior change" → `chore: extract request helper from API client`

### Message style

- Short single line, lowercase after prefix
- Focus on WHY, not WHAT
- No body, no scope unless disambiguation needed
- Match recent commit style from log

### Write the message to a file

Messages can contain `!` (e.g. `fix: handle invalid input!`) and zsh history expansion mangles it even inside single-quoted HEREDOCs. Write the message to `/tmp/claude/commit.txt` and pass `-F`:

```
Write(/tmp/claude/commit.txt, "<prefix>: <message>")
Bash(git commit -F /tmp/claude/commit.txt)
```

## Rules

- **Separate git commands.** Chained commands (`&&`, `;`) bypass the permissions allowlist.
- **Commit only.** Pushing is a separate user decision.
- **Preserve history.** Only amend when user explicitly asks.
- **Run hooks.** If a hook fails, fix the issue, re-stage, create a fresh commit.
