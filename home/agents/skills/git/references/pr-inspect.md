# Inspecting an existing PR

Checking a PR's state, comments, or CI sits outside the `/git pr` workflow — run `gh` directly. Read this file when the task is to look at a PR rather than create or update one. `<pr>` is a number, URL, or branch; omit it to act on the PR for the current branch.

- **State and metadata:** `gh pr view <pr>` — title, body, state, labels, reviewers. Add `--json state,mergeable,reviewDecision,statusCheckRollup` for a machine-readable summary.
- **CI checks:** `gh pr checks <pr>` — one line per check with pass/fail/pending. `gh pr checks <pr> --watch` blocks until checks settle.
- **A failing run's logs:** `gh run view <run-id> --log-failed` — only the failed steps. Get `<run-id>` from the `gh pr checks` output.
- **Review comments and threads:** `gh pr view <pr> --comments` — issue comments plus review threads in one stream.
- **The diff:** `gh pr diff <pr>`.

When CI fails: classify each failure as mechanical (lint, format, types — fixable by editing and re-pushing) or semantic (tests, infrastructure — needs diagnosis). Fix mechanical failures with a `fix:` commit via `commit.md`, then `git push`.
