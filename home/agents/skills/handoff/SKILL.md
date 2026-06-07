---
name: handoff
description: >
  Write or read an ephemeral handoff: a short-lived markdown packet that carries work-state
  between agents or sessions through a mktemp file path. Triggers: /handoff, "write a handoff",
  "hand this to the next session", capturing state before you /clear or compact context.
  Templates: brief (delegator→worker), result (worker→delegator), continuation
  (session→successor). For durable cross-session memory use /track; for orchestration use /work.
---

# Handoff

A handoff is one short-lived markdown file that carries work-state from one agent or session to the next. The writer creates it with `mktemp`, fills a template, and passes the path; the reader reads the path and acts. The file is the message: plain text both parties can inspect, not hidden context.

Handoffs are ephemeral by design — `$TMPDIR` scratch, no cleanup, no persistence. Durable carry-forward across cold launches is `/track`'s job; a continuation points at a durable record when one exists.

## Write a handoff

```
type = <type> from args (brief | result | continuation), else continuation
// Invoking /handoff before a /clear or compaction defaults to a continuation of the current session.

do("read <type>.md in this skill directory and fill its template")

path = Bash(mktemp "$TMPDIR/handoff-XXXXXX.md")
Write(path, "# Handoff: <type>\n\n<filled body>")
do("surface <path> to the reader: an orchestrator inlines it in the spawn prompt; a user-invoked handoff prints one copy-pasteable `read <path>` line for the next context to run, not the body")
```

## Read a handoff

```
do("Read the file at <path>; its first line — # Handoff: <type> — declares which template it is")
do("act on <type>: a brief is your task; a result updates your plan; a continuation resumes the effort")
```

## Templates

| type         | file              | purpose                                           |
| ------------ | ----------------- | ------------------------------------------------- |
| brief        | `brief.md`        | task packet from delegator to a fresh worker      |
| result       | `result.md`       | outcome report from worker back to delegator      |
| continuation | `continuation.md` | session-state packet for the same effort resuming |

## Boundaries

- **vs `/track`:** a handoff is ephemeral and carries into the very next context (e.g. across a `/clear`); a track is the durable, per-project work log saved at session boundaries. The two are independent: a continuation points at a track when one exists, but depends on none.
- **vs `/work`:** `/work` is orchestration policy — planning, delegation, git posture. It consumes handoff's brief and result templates to talk to its subagents; handoff owns only the message shape and the write/read protocol.
