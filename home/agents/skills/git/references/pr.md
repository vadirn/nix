# /git pr

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
if branch == default_branch: stop, ask user to create a feature branch (branch.md)
if uncommitted changes in status: follow commit.md

// Push
if no upstream: Bash(git push -u origin <branch>)
else if ahead: Bash(git push)

// Existing PR
existing = Bash(gh pr view --json url,state -q '.url' 2>/dev/null)

// Template (deterministic resolution via pr-template) — shared by create and update paths
out = Bash(pr-template)
mode = first line of out, stripped of "MODE: " prefix    // single | multi | default — see §PR creation details
rest = lines after the first

if mode == "multi":
  chosen = AskUserQuestion("pick a template", options = rest)
  template_content = Read(<git-root>/chosen)
else:
  template_content = rest    // single or default — both deliver content directly

if existing:
    show URL, AskUserQuestion("update or stop?")
    if stop: stop
    // update path — reuses template resolved above
    title = do("regenerate conventional commit-style title from diff and log")
    body  = do("regenerate body from diff and log, filling template_content sections; keep it self-contained (see §PR creation details); preserve every heading, emoji, and section verbatim")
    AskUserQuestion("confirm updated title and body")
    Bash(rm -f /tmp/claude/pr.md)
    Write(/tmp/claude/pr.md, body)
    Bash(gh pr edit --title "<title>" --body-file /tmp/claude/pr.md)
    Bash(rm -f /tmp/claude/pr.md)
    show PR URL, stop

title = do("generate conventional commit-style title: '<prefix>: <message>' — prefix by the contract test in prefix.md, message style per commit.md")
body = do("fill template_content placeholders from diff and log; keep it self-contained (see §PR creation details); preserve every heading, emoji, and section verbatim")

AskUserQuestion("confirm title, body, base branch, draft status")
Bash(rm -f /tmp/claude/pr.md)
Write(/tmp/claude/pr.md, body)
Bash(gh pr create --title "<title>" --body-file /tmp/claude/pr.md --draft)
Bash(rm -f /tmp/claude/pr.md)
show PR URL
```

## PR creation details

- **Draft by default.** Pass `--draft`. Omit only when user says "no draft" or "ready".
- **Title:** `<prefix>: <message>`, lowercase after prefix, <70 chars, focus on WHY — the same form a commit takes. The PR title becomes the commit message on squash-and-merge, so the prefix comes from the contract test applied to the branch's net change, not to any one commit.
- **Body:** Always start from a template. The `pr-template` script (at `home/agents/scripts/pr-template.sh`) resolves which template to use and prints one of three modes on its first line: `MODE: single` (full template content follows), `MODE: multi` (one repo-relative `.md` path per line — ask the user which), or `MODE: default` (the colocated `pr-template.md` default follows; used when the repo ships no template). In every mode the resulting body MUST keep the template's headings, emoji, and section count verbatim; only the placeholder content gets filled in from the diff and log.
- **Self-contained body.** The reader has the repo and nothing else. Derive the body from the diff and log — never from session-only context. Name only artifacts a reader can resolve from the repo (files, commits, symbols); strip references to private planning notes (vault tracks, note slugs like `track-*`), local paths outside the repo, ticket IDs, and prior-conversation shorthand. If a why comes from such a source, restate the reasoning inline rather than pointing at the source.
- **State what the diff cannot.** The body carries rationale, scope, and traps a reader would otherwise misread — never a restatement of what GitHub already renders. Skip commit counts, SHA ranges, and file lists: the branch view is always current and these are not, since a rebase invalidates every SHA and a force-push every count. Claims about behaviour survive a history rewrite; claims about history do not.
- **Write the body to a file.** Bodies often contain `!` (image markdown, exclamations) and zsh history expansion mangles it even inside single-quoted HEREDOCs. Write the body to `/tmp/claude/pr.md`, pass `--body-file`, then delete the file so the next run's Write sees a fresh path (the Write tool refuses to overwrite an existing file without a prior Read). Always remove the file before writing so a stale artifact left over from a crashed prior session cannot survive into a new PR — the `require-pr-body-file.sh` hook treats artifact existence as proof of skill use but has no freshness check, so freshness is enforced here via the pre-write rm:
  ```
  Bash(rm -f /tmp/claude/pr.md)
  Write(/tmp/claude/pr.md, body)
  Bash(gh pr create --title "<title>" --body-file /tmp/claude/pr.md --draft)
  Bash(rm -f /tmp/claude/pr.md)
  ```
  The body file also serves as proof of skill use: the `require-pr-body-file.sh` PreToolUse hook refuses `gh pr create` unless it points `--body-file` at `/tmp/claude/pr.md` and that file exists. Because gh reads the body straight from the file, the artifact IS the body — no separate nonce or time window. The skill deletes the file after the gh call, so the same artifact gates exactly one PR. Use `gh pr edit --body-file` for updates to an existing PR.
- **Confirm before creating.** Show title and body. Omit confirmation when the user supplied an explicit title and body.

## Rules

- **Commit first when the tree is dirty.** Route uncommitted changes through the commit workflow first.
