---
name: pr
description: >
  Create pull requests and check CI status. Triggers: /pr, "create pr", "open pr", "сделай PR",
  "пулл реквест", "check ci", "why is ci failing", "pr status", "проверь CI".
---

# PR

Create pull requests and check CI status.

```
command = user's command after /pr

if command == "check" or starts with "check" or asks about CI/checks:
    check_flow(command)
else:
    create_flow(command)
```

## Create flow

```
// Gather state (parallel)
status = Bash(git status)
branch = Bash(git rev-parse --abbrev-ref HEAD)
default_branch = Bash(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)
upstream = Bash(git rev-parse --abbrev-ref @{upstream} 2>/dev/null)
diff = Bash(git diff <default_branch>...HEAD)
log = Bash(git log <default_branch>..HEAD --oneline)

// Guards
if branch == default_branch: stop, ask user to create a feature branch
if uncommitted changes in status: Skill(commit), then stop

// Push
if no upstream: Bash(git push -u origin <branch>)
else if ahead: Bash(git push)

// Existing PR
existing = Bash(gh pr view --json url,state -q '.url' 2>/dev/null)
if existing: show URL, AskUserQuestion("update or stop?")

// Template (GitHub's resolution order)
multi = Glob(".github/PULL_REQUEST_TEMPLATE/*.md")
if multi has multiple files:
  chosen = AskUserQuestion("pick a template")
  template_content = Read(chosen)
else:
  for path in [".github/pull_request_template.md", "docs/pull_request_template.md", "pull_request_template.md"]:
    if Read(path) succeeds: template_content = result; break
  if no template_content:
    for path in [".github/PULL_REQUEST_TEMPLATE.md", "docs/PULL_REQUEST_TEMPLATE.md", "PULL_REQUEST_TEMPLATE.md"]:
      if Read(path) succeeds: template_content = result; break

title = do("generate conventional commit-style title: '<prefix>: <message>' (see /commit skill for prefix and message rules)")
if template_content:
  body = do("fill template_content placeholders from diff and log; preserve every heading, emoji, and section verbatim")
else:
  body = do("write ## Summary bullets and ## Test plan checklist from diff and log")

AskUserQuestion("confirm title, body, base branch, draft status")
Write(/tmp/claude/pr.md, body)
Bash(gh pr create --title "<title>" --body-file /tmp/claude/pr.md --draft)
Bash(rm -f /tmp/claude/pr.md)
show PR URL
```

## Check flow

```
pr = do("parse #N from command") or Bash(gh pr view --json number -q '.number')
checks = Bash(gh pr checks <pr>)

// Guards
if all checks pass: report success, stop
if some checks running: report status, suggest re-check later, stop

// Failures
logs = Bash(gh run view <run_id> --log-failed)
do("summarize errors, classify each as mechanical or semantic")
if any mechanical:
  AskUserQuestion("auto-fix mechanical failures?")
  Skill(commit)
  Bash(git push)
```

## Reference

### PR creation details

- **Draft by default.** Pass `--draft`. Omit only when user says "no draft" or "ready".
- **Title:** matches the /commit skill's conventions — `<prefix>: <message>`, lowercase after prefix, <70 chars, focus on WHY. The PR title becomes the commit message on squash-and-merge, so the same prefix selection (feat/fix/chore) and message style apply.
- **Body:** When a PR template exists, the body MUST be that template with placeholders filled in. Keep every heading, emoji, and section verbatim — preserve original names, order, and section count. Resolution order matches GitHub's: `.github/PULL_REQUEST_TEMPLATE/*.md` (multi — ask which), then single-template at `.github/pull_request_template.md` → `docs/pull_request_template.md` → `pull_request_template.md` (and uppercase variants). Fall back to `## Summary` (bullets) + `## Test plan` (checklist) only when the repo has no template file.
- **Write the body to a file.** Bodies often contain `!` (image markdown, exclamations) and zsh history expansion mangles it even inside single-quoted HEREDOCs. Write the body to `/tmp/claude/pr.md`, pass `--body-file`, then delete the file so the next run's Write sees a fresh path (the Write tool refuses to overwrite an existing file without a prior Read):
  ```
  Write(/tmp/claude/pr.md, body)
  Bash(gh pr create --title "<title>" --body-file /tmp/claude/pr.md --draft)
  Bash(rm -f /tmp/claude/pr.md)
  ```
  Use `gh pr edit --body-file` for updates to an existing PR.
- **Confirm before creating.** Show title and body. Skip the confirmation only when the user supplied an explicit title and body.

### CI check details

- Show 3-5 key error lines per failure, link to full run.
- **Mechanical failures** (lint/format/types): offer to auto-fix, commit with `fix:` prefix, push.
- **Semantic failures** (tests/infra): diagnose and explain.

## Rules

- **Run git commands separately.** Chained commands (`&&`, `;`) bypass the permissions allowlist.
- **Auto-detect base branch.** Use `gh repo view`. Ask the user only when detection fails.
