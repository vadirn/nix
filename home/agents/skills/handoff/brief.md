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
If the task needs its own multi-step orchestration, surface that in ## Backlog rather
than invoking /work yourself.
```

Phrase every directive affirmatively (the `/affirm` convention): the positive form is narrower and defines done. "Edit only `rules/<name>.rs`" beats "do NOT touch other files".
