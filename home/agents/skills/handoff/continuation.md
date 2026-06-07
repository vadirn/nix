# Continuation handoff template — session → its successor

A result and a brief fused: it reports what is done and directs what is next, because the reader is the same effort resuming.

```
# Handoff: continuation

## Status          <- complete | in-progress | blocked
## Done            <- what this session finished
## Left            <- what remains
## How to continue <- the exact next action(s) for the successor
```

`## How to continue` is the field that removes the successor's startup cost: name the next action, not the history. A continuation stands alone — its four fields need no other file to be acted on. When a durable source is worth reading (a track, a design doc, a path), name it in `## How to continue` as one of the next actions; the template prescribes none. A continuation lives one `$TMPDIR` lifetime; durable continuity across a cold launch is a separate concern (see `SKILL.md` §Boundaries).

`## Recap` inside a continuation follows the prose-only rule defined in `result.md` — a paragraph of prose, no structured dumps.

Phrase every directive affirmatively (the `/affirm` convention): the positive form is narrower and defines done.
