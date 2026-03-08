## PR create flow

```
// Gather state (parallel)
status = Bash(git status)
branch = Bash(git rev-parse --abbrev-ref HEAD)
default_branch = Bash(gh repo view --json defaultBranchRef -q '.defaultBranchRef.name')

// Guards
if branch == default_branch: stop("create a feature branch first")
if uncommitted changes in status: Skill(commit), then stop

// Push if needed
upstream = Bash(git rev-parse --abbrev-ref @{u})
if no upstream: Bash(git push -u origin <branch>)
else if ahead of upstream: Bash(git push)

// Check existing PR
existing_pr = Bash(gh pr view --json url -q '.url')
if existing_pr exists: show URL, AskUserQuestion("Update existing PR or stop?")

// Generate PR content
diff = Bash(git diff <default_branch>...HEAD)
log = Bash(git log <default_branch>..HEAD --oneline)
title, body = do("generate title and body from diff and log")

// Confirm and create
do("show title and body to user")
AskUserQuestion("Create this draft PR? (y/n)")
Bash(gh pr create --title "<title>" --body "$(cat <<'EOF'
<body>
EOF
)" --draft)
```

## Reference

### PR title

- Under 70 characters
- Conventional commit style (`feat:`, `fix:`, `chore:`)

### PR body

- `## Summary` with 1-3 bullet points
- `## Test plan` with bulleted checklist of testing TODOs

### Push logic

- No upstream: `git push -u origin <branch>` to set tracking
- Has upstream and ahead: `git push`
- Otherwise: skip

### Draft mode

- Always create as draft unless user explicitly says otherwise
