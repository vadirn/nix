# Why the message goes through a file

Read when the `commit-msg` hook rejects a commit and the reason is not obvious from its output.

Messages can contain `!` (e.g. `fix: handle invalid input!`) and zsh history expansion mangles it even inside single-quoted HEREDOCs. Passing `-F /tmp/claude/commit.txt` sidesteps the shell entirely. The file is deleted after the commit so the next run's `Write` sees a fresh path (the `Write` tool refuses to overwrite an existing file without a prior `Read`). The file also serves as proof of skill use: the global `commit-msg` hook reads it and refuses the commit unless its content matches what git received as the commit message. There is no separate nonce file and no time window. The hook deletes `commit.txt` on success, so the same artifact validates exactly one commit.

The three rules in `commit.md` §The message file follow from that design. A rejection they do not explain is a hook problem rather than a message problem — read the hook at `home/git/hooks/commit-msg` before working around it.
