# Why the message goes through a file

Read when the `commit-msg` hook rejects a commit and the reason is not obvious from its output.

Messages can contain `!` (e.g. `fix: handle invalid input!`). Zsh history expansion mangles it even inside single-quoted HEREDOCs. Passing `-F <artifact_dir>/commit.txt` sidesteps the shell entirely. The file is deleted after the commit so the next run's `Write` sees a fresh path (the `Write` tool refuses to overwrite an existing file without a prior `Read`). The file also serves as proof of skill use: the global `commit-msg` hook reads it and refuses the commit unless its content matches what git received as the commit message. There is no separate nonce file and no time window. The hook deletes `commit.txt` on success, so the same artifact validates exactly one commit.

The four rules in `commit.md` §The message file follow from that design. A rejection they do not explain is a hook problem rather than a message problem. Read the hook at `home/git/hooks/commit-msg` before working around it.

## Why the path carries its owner

The path is `/tmp/claude/<session>/<worktree>/commit.txt`, so no two sessions share a message file. The proof of skill use shows that a file matches the message. It cannot show whose file it read.

That gap broke a commit on 2026-10-01. Sessions then shared one fixed path, `/tmp/claude/commit.txt`. One session wrote its message there. A second session in another repository committed first and took that message. The hook passed, because file and message matched.

Each part of the path rules out one collision:

- `<session>` is `CLAUDE_CODE_SESSION_ID`. Claude Code exports it to every shell next to `CLAUDECODE`, and git passes it on to hooks. It separates concurrent sessions.
- `<worktree>` is the first 12 hex digits of the SHA-1 of `git rev-parse --show-toplevel`. Subagents share their parent's session id, so it separates parallel subagents in different worktrees.

The worktree part is a hash because a worktree path can contain `.git` or `.claude`. The `Write` tool asks for permission before it writes under either. The same guard rules out a file inside the git dir.

Four places compute this path, and they must agree:

- `commit.md`, in the gather step,
- `pr.md`, in the gather step,
- the `commit-msg` hook, to find the file,
- the `post-commit` hook, to find the sentinel that `commit-msg` drops.

The `require-pr-body-file.sh` hook checks only the session part and the file name.
