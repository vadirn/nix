# /git pr

Create a pull request from the current branch.

```
// Gather state (parallel)
status = Bash(git status)
branch = Bash(git rev-parse --abbrev-ref HEAD)
default_branch = Bash(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)
upstream = Bash(git rev-parse --abbrev-ref @{upstream} 2>/dev/null)
artifact_dir = Bash(echo "/tmp/claude/${CLAUDE_CODE_SESSION_ID:-none}/$(git rev-parse --show-toplevel | shasum | cut -c1-12)")   // this session's and worktree's own directory, see commit-hook.md

// Base: the branch this PR merges into
base = do("default_branch, unless this branch was stacked on another (/git branch) — then that parent branch")
base_pr = Bash(gh pr list --head <base> --state open --json number -q '.[0].number')   // empty unless base is an open PR's branch

// Gather diff and log (depend on base)
diff = Bash(git diff <base>...HEAD)
log = Bash(git log <base>..HEAD --oneline)

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

if template_content has a gif section: titles = Bash(pr-gif)    // the body fills it, see §PR creation details

if existing:
    show URL, AskUserQuestion("update or stop?")
    if stop: stop
    // update path — reuses template resolved above
    title = do("regenerate conventional commit-style title from diff and log")
    body  = do("regenerate body from diff and log, filling template_content sections; keep it self-contained (see §PR creation details); preserve every heading, emoji, and section verbatim")
    do("check body against diff (see §PR creation details); fix each mismatch")
    AskUserQuestion("confirm updated title and body")
    Bash(rm -f <artifact_dir>/pr.md)
    Write(<artifact_dir>/pr.md, body)
    Bash(gh pr edit --title "<title>" --body-file <artifact_dir>/pr.md)
    Bash(rm -f <artifact_dir>/pr.md)
    show PR URL
    if body has a before/after section: do("suggest the user record the screencast its comment asks for and drop it into the PR")
    stop

title = do("generate conventional commit-style title: '<prefix>: <message>' — prefix by the contract test in prefix.md, message style per commit.md")
body = do("fill template_content placeholders from diff and log; keep it self-contained (see §PR creation details); preserve every heading, emoji, and section verbatim")
do("check body against diff (see §PR creation details); fix each mismatch")

AskUserQuestion("confirm title, body, base branch, draft status")
Bash(rm -f <artifact_dir>/pr.md)
Write(<artifact_dir>/pr.md, body)
Bash(gh pr create --base <base> --title "<title>" --body-file <artifact_dir>/pr.md --draft)
Bash(rm -f <artifact_dir>/pr.md)
if base_pr and every branch below base has an open PR: Bash(gh stack link <every stack PR through base_pr, bottom first> <new PR>)   // see §PR creation details
show PR URL
if body has a before/after section: do("suggest the user record the screencast its comment asks for and drop it into the PR")
```

## PR creation details

- **Draft by default.** Pass `--draft`. Omit only when user says "no draft" or "ready".
- **Link a stacked PR.** `--base` sets the base branch but does not put the PR in a GitHub stack. When the base is another open PR's branch, run `gh stack link <base PR> <new PR>` after `gh pr create`. Given PR numbers, it pushes nothing. When the base PR already sits in a stack, list every PR in the stack, bottom first, then the new one: `gh stack link <bottom> … <base PR> <new PR>`. Naming only the base PR and the new one fails with "this would remove #<bottom> from the stack". Open a PR for every branch below first. A link whose bottom PR does not target the default branch moves that PR's base to the default branch, and GitHub then refuses base edits on a stacked PR. To recover, run `gh stack unstack <stack number>`, then `gh pr edit <PR> --base <branch>`.
- **Title:** `<prefix>: <message>`, lowercase after prefix, <70 chars, focus on WHY — the same form a commit takes. The PR title becomes the commit message on squash-and-merge, so the prefix comes from the contract test applied to the branch's net change, not to any one commit.
- **Body:** Always start from a template. The `pr-template` script (at `home/agents/scripts/pr-template.sh`) resolves which template to use and prints one of three modes on its first line: `MODE: single` (full template content follows), `MODE: multi` (one repo-relative `.md` path per line — ask the user which), or `MODE: default` (the colocated `pr-template.md` default follows; used when the repo ships no template). In every mode the resulting body keeps the template's headings, emoji, and section count verbatim. The one exception is an optional section: a template region `<!-- optional: <when> -->` … `<!-- /optional -->` that holds its heading. Drop the whole region, heading and all, when `<when>` does not hold. Otherwise keep the section and drop only the two region comments. Only the placeholder content gets filled in from the diff and log. Replace each comment with the content it asks for. Keep a comment only in a section you cannot fill, such as the default template's before/after screencast.
- **Fill the gif section from the library.** A template section that asks for a GIF, such as `## 👏 Accompanying gif`, takes one GIF. From the titles `pr-gif` lists, pick the one that fits the branch's net change best. Replace the section's comment with the line `pr-gif "<title>"` prints.
- **Self-contained body.** The reader has the repo and nothing else. Derive the body from the diff and log — never from session-only context. Name only artifacts a reader can resolve from the repo (files, commits, symbols). Strip references to private planning notes (vault tracks, note slugs like `track-*`), local paths outside the repo, ticket IDs, and prior-conversation shorthand. If a why comes from such a source, restate the reasoning inline rather than pointing at the source.
- **State what the diff cannot.** The body carries rationale, scope, and traps a reader would otherwise misread — never a restatement of what GitHub already renders. Skip commit counts, SHA ranges, and file lists: the branch view renders those and stays current across a rebase or force-push, which the body would not. Skip a record of checks run, such as the commands, test counts, timings and one-off live runs. CI shows check results and stays current, but such a record goes stale at the next push. Steps a reviewer can follow by hand are not such a record, so the Check step keeps them.
- **Write the body as a proof, general to particular.** A reader judges the PR from its opening and reads on only for the detail they need. Fill the template in this order. The template's headings and comments say which section takes which step, and they win over this rule on a section's content and layout. A template whose only open slot names no step, such as a lone `1. ...` list, takes all five steps in that slot: the thesis first, then each other step under its own `###` heading, as in the default template:
  1. **Thesis.** Open with what the PR does and why, in one or two sentences. Then name what it leaves alone when a reader could expect it to change. Say what changes for users, including anything that breaks.
  2. **Why.** The state before the PR and the one obstacle it removes. For a bug, name the case where it appears, the case where it does not, and the factor that differs.
  3. **How.** Each change as it follows from that obstacle: where each moved piece went, as a map from old to new; the mechanisms, simplest first; then each secondary deliverable, such as a new rule or a report. Name every change a reader would not expect from the thesis, including those nobody asked for. For each decision with a real alternative, say why the alternative lost. Write it as prose, one paragraph per mechanism when one paragraph cannot hold them.
  4. **Limits.** What the PR assumes, works around, leaves unverified or defers, each with its reason. A workaround names what it suppresses and where the cause lives. Name every test the PR edits, skips or deletes, and every check it loosens: the diff shows the edit but not its reason.
  5. **Check.** Steps a reviewer can follow by hand, and what each should show.

  Write every step. Within How, skip a part that has nothing, such as the map when nothing moved. Where the template has a slot for Limits or Check, an empty one says so in one line, such as "None known.", since a missing one reads as never considered. Where it has no slot for a step, fold the step into the nearest section. Use a list only for parallel items, such as the map of moved pieces or the steps to check. State each fact once. Describe the current state, never its history: a fixed CI failure or a resolved conflict belongs in the commits.
- **Check the body against the diff.** Before confirming, match each claim to the diff. Cut a change the diff does not make, name an unexpected change the body leaves out, and leave no placeholder. Only a section you cannot fill keeps its comment, per the Body rule. When an agent PR's body and code disagree, the commonest case is a claimed change the code never got, and such PRs merge far less often.
- **Simplified governs the filled prose only.** The Simplified output style shapes the placeholder text you write into each section. It leaves the template's headings, emoji, and section count verbatim, per the Body rule above. Styling the scaffolding would break the template contract.
- **Write the body to a file.** Bodies often contain `!` (image markdown, exclamations). Zsh history expansion mangles it even inside single-quoted HEREDOCs. Write the body to `<artifact_dir>/pr.md`, pass `--body-file`, then delete the file so the next run's Write sees a fresh path (the Write tool refuses to overwrite an existing file without a prior Read). `artifact_dir` is this session's and worktree's own directory, so concurrent sessions never touch each other's body (`commit-hook.md` says why). Always remove the file before writing so a stale artifact left over from a failed earlier run cannot survive into a new PR:
  ```
  Bash(rm -f <artifact_dir>/pr.md)
  Write(<artifact_dir>/pr.md, body)
  Bash(gh pr create --base <base> --title "<title>" --body-file <artifact_dir>/pr.md --draft)
  Bash(rm -f <artifact_dir>/pr.md)
  ```
  The message hook checks the title, the body file and the repo's template before `gh pr create` or `gh pr edit` runs (`commit-hook.md` says how). On a refusal, apply each fix, rewrite `pr.md`, and run the command again. If you think a finding is wrong, stop and ask the user.
- **Confirm before creating.** Show title and body. Omit confirmation when the user supplied an explicit title and body.

## Rules

- **Commit first when the tree is dirty.** Route uncommitted changes through the commit workflow first.
- **A revert is its own PR.** Never bundle a revert with unrelated work. Squash-and-merge collapses the branch to one line, so a revert riding inside a multi-concern PR hides under the roll-up title and can silently clobber a sibling change. Ship the undo alone. (Unit rule in `prefix.md`.)
