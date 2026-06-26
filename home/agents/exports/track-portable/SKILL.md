---
name: track
description: >
  Read or save a per-repo track — the rolling handoff file in `<repo-root>/.tracks/track-<slug>.md`.
  Triggers on explicit `/track` and `/track save` commands. Also triggers on session save/checkpoint phrases:
  "wrapping up", "save what we did", "log what we accomplished", "save our progress", "end of session",
  "save session", "we finished X and still need to do Y". Triggers on resume phrases: "what was I working on",
  "where did we leave off", "continue where I left off", "pick up the track". Track creation, status changes,
  Decisions/Backlog/Log edits, atomic write to disk all live here. Self-contained: no vault, no external
  config, no extra tools — just the repo working tree.
---

# Track

Rolling per-repo work artifact. One file per ongoing line of work, kept inside the repo at `.tracks/`.
Updated across many sessions.

```
dir = skill base directory

if args contains "save":
    Read(dir/references/save.md)
    do("follow save procedure")
else:
    Read(dir/references/read.md)
    do("follow read procedure")
```

## Reference

| File                       | Purpose                                                            |
| -------------------------- | ------------------------------------------------------------------ |
| `references/read.md`       | Resume a track. Lists Active tracks, picks one, presents the body. |
| `references/save.md`       | Save session work into an existing track or create a new one.      |
| `assets/track-template.md` | Embedded template instantiated when creating a new track.          |

Tracks live in the repo at `<repo-root>/.tracks/track-<slug>.md`, where `<repo-root>` is the output of
`git rev-parse --show-toplevel` (falling back to `pwd` outside a git repo). Active tracks are those whose
frontmatter `status` is **not** `done`, `closed`, or `archived`.
