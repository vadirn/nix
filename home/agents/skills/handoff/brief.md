# Brief handoff template — delegator → worker

What a fresh subagent needs to act.

```
# Handoff: brief

## Task
<single goal — one sentence, then 2-4 bullets of acceptance criteria>

## Context
<prior decisions for this step; any $TMPDIR paths to read; constraints>

## Return
Reply with a result handoff (## Recap / ## Modified files / ## Decisions / ## Backlog).
## Recap is short prose only: no lists, code blocks, tables, or file dumps; bulk goes to $TMPDIR, cited by path.
If the task needs its own multi-step orchestration, surface that in ## Backlog rather
than invoking /work yourself.
```

Phrase every directive affirmatively (the `/affirm` convention): an affirmative directive names a verifiable target state, while a negative directive leaves the exclusions open-ended. "Edit only `rules/<name>.rs`" beats "do NOT touch other files".
