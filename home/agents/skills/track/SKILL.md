---
name: track
description: >
  Read or save a per-project rolling work log at `41 projects/<project>/track-<slug>.md`.
  Triggers: `/track`, save phrases ("wrapping up", "save session", "end of session"), resume phrases
  ("what was I working on", "where did we leave off"). Non-track artifacts (cards/notes/references)
  route to /vault.
---

# Track

Rolling per-project work artifact. One file per effort, updated across the many sessions it spans.

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

| File                 | Purpose                                                            |
| -------------------- | ------------------------------------------------------------------ |
| `references/read.md` | Resume a track. Lists Active tracks, picks one, presents the body. |
| `references/save.md` | Save session work into an existing track or create a new one.      |

Tracks live in the vault at `<vault_root>/41 projects/<project>/track-<slug>.md`. The vault skill handles discovery
(`/vault track <fragment>`); this skill handles the read/save loop.
