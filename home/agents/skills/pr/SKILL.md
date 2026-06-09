---
name: pr
description: >
  Create pull requests. Triggers: /pr, "create pr", "open pr", "draft pr",
  "сделай PR", "оформи PR", "пулл реквест". Skip for inspecting an existing
  PR's state, comments, or CI; those are plain `gh` commands (see Reference).
---

# PR

Create a pull request from the current branch.

```
// Gather state (parallel)
status = Bash(git status)
branch = Bash(git rev-parse --abbrev-ref HEAD)
default_branch = Bash(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)
upstream = Bash(git rev-parse --abbrev-ref @{upstream} 2>/dev/null)

// Gather diff and log (depend on default_branch)
diff = Bash(git diff <default_branch>...HEAD)
log = Bash(git log <default_branch>..HEAD --oneline)

// Guards
if branch == default_branch: stop, ask user to create a feature branch (see /git-branch)
if uncommitted changes in status: Skill(commit)

// Push
if no upstream: Bash(git push -u origin <branch>)
else if ahead: Bash(git push)

// Existing PR
existing = Bash(gh pr view --json url,state -q '.url' 2>/dev/null)
if existing:
    show URL, AskUserQuestion("update or stop?")
    if stop: stop
    // update path
    title = do("regenerate conventional commit-style title from diff and log")
    body  = do("regenerate body from diff and log, filling the existing template's sections")
    AskUserQuestion("confirm updated title and body")
    Bash(rm -f /tmp/claude/pr.md)
    Write(/tmp/claude/pr.md, body)
    Bash(gh pr edit --title "<title>" --body-file /tmp/claude/pr.md)
    Bash(rm -f /tmp/claude/pr.md)
    show PR URL, stop

// Template (deterministic resolution via pr-template)
out = Bash(pr-template)
mode = first line of out, stripped of "MODE: " prefix    // single | multi | default — see Reference §PR creation details
rest = lines after the first

if mode == "multi":
  chosen = AskUserQuestion("pick a template", options = rest)
  template_content = Read(<git-root>/chosen)
else:
  template_content = rest    // single or default — both deliver content directly

title = do("generate conventional commit-style title: '<prefix>: <message>' (see /commit skill for prefix and message rules)")
body = do("fill template_content placeholders from diff and log; preserve every heading, emoji, and section verbatim")

AskUserQuestion("confirm title, body, base branch, draft status")
Bash(rm -f /tmp/claude/pr.md)
Write(/tmp/claude/pr.md, body)
Bash(gh pr create --title "<title>" --body-file /tmp/claude/pr.md --draft)
Bash(rm -f /tmp/claude/pr.md)
show PR URL
```

## Reference

### PR creation details

- **Draft by default.** Pass `--draft`. Omit only when user says "no draft" or "ready".
- **Title:** matches the /commit skill's conventions — `<prefix>: <message>`, lowercase after prefix, <70 chars, focus on WHY. The PR title becomes the commit message on squash-and-merge, so the same prefix selection (feat/fix/chore) and message style apply.
- **Body:** Always start from a template — never freeform. The `pr-template` script (at `home/agents/scripts/pr-template.sh`) resolves which template to use and prints one of three modes on its first line: `MODE: single` (full template content follows), `MODE: multi` (one repo-relative `.md` path per line — ask the user which), or `MODE: default` (the colocated `pr-template.md` default follows; used when the repo ships no template). In every mode the resulting body MUST keep the template's headings, emoji, and section count verbatim; only the placeholder content gets filled in from the diff and log.
- **Write the body to a file.** Bodies often contain `!` (image markdown, exclamations) and zsh history expansion mangles it even inside single-quoted HEREDOCs. Write the body to `/tmp/claude/pr.md`, pass `--body-file`, then delete the file so the next run's Write sees a fresh path (the Write tool refuses to overwrite an existing file without a prior Read). Always remove the file before writing so a stale artifact left over from a crashed prior session cannot survive into a new PR — the `require-pr-body-file.sh` hook treats artifact existence as proof of skill use but has no freshness check, so freshness is enforced here via the pre-write rm:
  ```
  Bash(rm -f /tmp/claude/pr.md)
  Write(/tmp/claude/pr.md, body)
  Bash(gh pr create --title "<title>" --body-file /tmp/claude/pr.md --draft)
  Bash(rm -f /tmp/claude/pr.md)
  ```
  The body file also serves as proof of skill use: the `require-pr-body-file.sh` PreToolUse hook refuses `gh pr create` unless it points `--body-file` at `/tmp/claude/pr.md` and that file exists. Because gh reads the body straight from the file, the artifact IS the body — no separate nonce or time window. The skill deletes the file after the gh call, so the same artifact gates exactly one PR.
  Use `gh pr edit --body-file` for updates to an existing PR.
- **Confirm before creating.** Show title and body. Skip the confirmation only when the user supplied an explicit title and body.

### Inspecting an existing PR

Checking a PR's state, comments, or CI sits outside this skill's workflow — run `gh` directly. `<pr>` is a number, URL, or branch; omit it to act on the PR for the current branch.

- **State and metadata:** `gh pr view <pr>` — title, body, state, labels, reviewers. Add `--json state,mergeable,reviewDecision,statusCheckRollup` for a machine-readable summary.
- **CI checks:** `gh pr checks <pr>` — one line per check with pass/fail/pending. `gh pr checks <pr> --watch` blocks until checks settle.
- **A failing run's logs:** `gh run view <run-id> --log-failed` — only the failed steps. Get `<run-id>` from the `gh pr checks` output.
- **Review comments and threads:** `gh pr view <pr> --comments` — issue comments plus review threads in one stream.
- **The diff:** `gh pr diff <pr>`.

When CI fails: classify each failure as mechanical (lint, format, types — fixable by editing and re-pushing) or semantic (tests, infrastructure — needs diagnosis). Fix mechanical failures with a `fix:` commit via the /commit skill, then `git push`.

## Rules

- **Run git commands separately.** Chained commands (`&&`, `;`) bypass the permissions allowlist.
- **Auto-detect base branch.** Use `gh repo view`. Ask the user only when detection fails.
- **Commit first when the tree is dirty.** Route uncommitted changes through the /commit skill first.
