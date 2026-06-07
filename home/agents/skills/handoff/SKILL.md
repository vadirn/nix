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

if type == continuation:
    do("capture the current session as Status / Done / Left / How to continue; name any durable source worth reading (a track, a doc, a path) as a next action in How to continue")
else:
    do("fill the brief or result template — see Reference §Templates")

path = Bash(mktemp "$TMPDIR/handoff-XXXXXX.md")
Write(path, "# Handoff: <type>\n\n<filled body>")
do("surface <path> to the reader: an orchestrator inlines it in the spawn prompt; a user-invoked handoff prints one copy-pasteable `read <path>` line for the next context to run, not the body")
```

## Read a handoff

```
do("Read the file at <path>; its first line — # Handoff: <type> — declares which template it is")
do("act on <type>: a brief is your task; a result updates your plan; a continuation resumes the effort")
```

## Reference

### Templates

Each doc opens with `# Handoff: <type>` so it is self-describing. Phrase every directive affirmatively (the `/affirm` convention): the positive form is narrower and defines done. "Edit only `rules/<name>.rs`" beats "do NOT touch other files".

**brief** — delegator → worker. What a fresh subagent needs to act.

```
# Handoff: brief

## Task
<single goal — one sentence, then 2-4 bullets of acceptance criteria>

## Context
<prior decisions for this step; any $TMPDIR paths to read; constraints>

## Return
Reply with a result handoff (## Recap / ## Modified files / ## Decisions / ## Backlog).
If the task needs its own multi-step orchestration, surface that in ## Backlog rather
than invoking /work yourself.
```

**result** — worker → delegator. What the worker did and what it hands back.

```
# Handoff: result

## Recap
## Modified files
## Decisions
## Backlog
```

Return a result inline in the final message by default; write it to a `mktemp` file and pass the path only when it is bulky. `## Recap` is prose only — no lists, code blocks, tables, or file dumps; structured findings go to `$TMPDIR`, cited by path. Aim for one short paragraph. `## Modified files` lists paths only; `## Decisions` and `## Backlog` are numbered lists.

**continuation** — session → its successor, written before clearing context. A result and a brief fused: it reports what is done and directs what is next, because the reader is the same effort resuming.

```
# Handoff: continuation

## Status          <- complete | in-progress | blocked
## Done            <- what this session finished
## Left            <- what remains
## How to continue <- the exact next action(s) for the successor
```

`## How to continue` is the field that removes the successor's startup cost: name the next action, not the history. A continuation stands alone — its four fields need no other file to be acted on. When a durable source is worth reading (a track, a design doc, a path), name it in `## How to continue` as one of the next actions; the template prescribes none. A continuation lives one `$TMPDIR` lifetime; durable continuity across a cold launch is a separate concern (see §Boundaries).

### Recap discipline

The prose-only rule on `## Recap` keeps inter-agent context small without active compaction: the reader forwards a Recap as-is into the next handoff's `## Context`. The constraint is structural, not numerical — a writer can reliably self-check "is this a paragraph of prose?" but cannot count its own tokens. It catches the actual cause of bloat (structured dumps), which belong in `$TMPDIR`. The discipline applies only to Recap; the other sections keep their structured forms.

### Boundaries

- **vs `/track`:** a handoff is ephemeral and carries into the very next context (e.g. across a `/clear`); a track is the durable, per-project work log saved at session boundaries. The two are independent: a continuation points at a track when one exists, but depends on none.
- **vs `/work`:** `/work` is orchestration policy — planning, delegation, git posture. It consumes handoff's brief and result templates to talk to its subagents; handoff owns only the message shape and the write/read protocol.
