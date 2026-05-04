---
name: track
description: >
  Read or save a per-project track — the rolling handoff file in `41 projects/<project>/track-<slug>.md`.
  Triggers on explicit `/track` and `/track save` commands. Also triggers on session save/checkpoint phrases:
  "wrapping up", "save what we did", "log what we accomplished", "save our progress", "end of session",
  "save session", "we finished X and still need to do Y". Triggers on resume phrases: "what was I working on",
  "where did we leave off", "continue where I left off", "pick up the track". Track creation, status changes,
  Decisions/Backlog/Log edits, atomic write to disk all live here. Excludes: editing arbitrary track markdown
  (use the file editor directly), creating non-track artifacts (cards/notes/references — those route to /vault).
---

# Track

Rolling per-project work artifact. One file per ongoing line of work. Updated across many sessions.

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
