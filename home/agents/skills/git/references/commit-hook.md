# Why the message hook is shaped this way

Read when the message hook refuses a commit or a PR and its fixes do not explain why.

The hook is `home/claude/hooks/git-message.py`, a PreToolUse hook on Bash. It runs on `git commit`, `gh pr create` and `gh pr edit`. It checks what a message says, not where it came from. The Trinket workflow `git.message` holds the rules: code rules for form, and Jev rules for meaning in repos its **Allowed repos** setting lists.

## What it sends

- **A commit** sends the whole message and the diff git will commit: `--cached` by default, `HEAD` for `-a`, `HEAD -- <paths>` for a pathspec, and `HEAD~1` for `--amend`. A body fails the single-line rule, because commits carry no body.
- **A PR** sends the title, the body, and the repo's PR template, so a missing heading fails.
- **A PR edit** sends the new body, and the new title when it changes one. A new title alone is refused, because the hook would need the current body from GitHub. An edit that changes neither, such as a label, passes unchecked.
- **All** send the origin's `owner/repo`, which decides whether Jev is asked. A PR's `--repo` or PR URL overrides it.

## Why it refuses what it cannot read

The hook runs before the command, so it reads only what exists then:

- **A message file written in the same command** does not exist yet.
- **Files staged in the same command** are not in the diff yet.
- **`-F -` fed by a pipe**, or a `-m` value built by `$(…)`, hides the text.

A check that does not finish refuses too: no engine, a failed run, or a Jev outage. Each refusal names its cause. A commit with no `-m` or `-F`, `--no-edit`, `-C` and `--fixup` pass unchecked.

A refusal the fixes do not explain is a hook problem rather than a message problem. Read the hook, then ask the user.

## Why the message goes through a file

Messages can contain `!` (e.g. `fix: handle invalid input!`). The Bash tool turns it into `\!`, even inside single-quoted heredocs. Passing `-F <artifact_dir>/commit.txt` sidesteps the shell entirely. The skill removes the file before writing it and after the commit, because the `Write` tool refuses to overwrite a file it has not read.

## Why the path carries its owner

The path is `/tmp/claude/<session>/<worktree>/commit.txt`, so no two sessions share a message file.

A shared path broke a commit on 2026-10-01. Sessions then shared one fixed path, `/tmp/claude/commit.txt`. One session wrote its message there. A second session in another repository committed first and took that message.

Each part of the path rules out one collision:

- `<session>` is `CLAUDE_CODE_SESSION_ID`. Claude Code exports it to every shell next to `CLAUDECODE`. It separates concurrent sessions.
- `<worktree>` is the first 12 hex digits of the SHA-1 of `git rev-parse --show-toplevel`. Subagents share their parent's session id, so it separates parallel subagents in different worktrees.

The worktree part is a hash because a worktree path can contain `.git` or `.claude`. The `Write` tool asks for permission before it writes under either. The same guard rules out a file inside the git dir.

`commit.md` and `pr.md` compute this path in their gather steps, and they must agree.
