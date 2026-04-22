---
name: pr
description: >
  Create pull requests and check CI status. Use when the user says "create pr", "open pr",
  "make a pr", "pr", "сделай PR", "открой PR", "пулл реквест", "check ci", "why is ci failing",
  "pr status", "are checks passing", "что с CI", "проверь CI". Also use when the user finishes
  work and wants to open a PR.
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
if branch == default_branch: stop, tell user to create a feature branch
if uncommitted changes: Skill(commit), then stop

// Push if needed
if no upstream: Bash(git push -u origin <branch>)
else if ahead: Bash(git push)

// Check for existing PR
existing = Bash(gh pr view --json url,state -q '.url' 2>/dev/null)
if existing: show URL, ask update or stop

// Load PR template
templates = Glob(".github/PULL_REQUEST_TEMPLATE/*.md")
if templates has multiple files:
  AskUserQuestion: let user pick which template to use
  template_content = Read(chosen template)
else:
  // Single template: check standard locations (GitHub uses first found)
  template = Glob("**/{pull_request_template,PULL_REQUEST_TEMPLATE}.md")
  if template: template_content = Read(first match)

title, body = generate from diff and log, using template_content as body structure if available
confirm with user: title, body, base branch, draft status
Bash(gh pr create --title "<title>" --body "$(cat <<'EOF' ... EOF)" --draft)
show PR URL
```

## Check flow

```
pr = parse #N from command, or Bash(gh pr view --json number -q '.number')
checks = Bash(gh pr checks [<pr>])

if all pass: report success, stop
if some running: report status, suggest re-check later, stop

// On failures
logs = Bash(gh run view <run_id> --log-failed)
summarize errors, categorize mechanical vs semantic
if mechanical: offer to fix, Skill(commit), Bash(git push)
```

## Reference

### PR creation details

- **Draft by default.** Always pass `--draft`. Omit only when user says "no draft" or "ready".
- **Title:** <70 chars, conventional style matching commit prefixes.
- **Body:** If `.github/PULL_REQUEST_TEMPLATE/` has multiple templates, ask user to pick one. Otherwise use the single template from any standard location. Fill in template sections from the diff. Fall back to `## Summary` (bullet points) + `## Test plan` (checklist) if no template found.
- **HEREDOC for body.** Preserves formatting:
  ```
  gh pr create --title "<title>" --body "$(cat <<'EOF'
  <body>
  EOF
  )"
  ```
- **Confirm before creating.** Show title and body. Skip only when user provided explicit title+body.

### CI check details

- Show 3-5 key error lines per failure, link to full run.
- **Mechanical failures** (lint/format/types): offer to auto-fix, commit with `fix:` prefix, push.
- **Semantic failures** (tests/infra): diagnose and explain only.

## Rules

- **Separate git commands.** Chained commands (`&&`, `;`) bypass the permissions allowlist.
- **Auto-detect base branch.** Use `gh repo view`. Ask only when detection fails.
