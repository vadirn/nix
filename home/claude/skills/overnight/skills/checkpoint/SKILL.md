---
name: checkpoint
description: >
  Write a structured checkpoint at the end of every overnight round.
  Produces checkpoint-<timestamp>-<seq>.md with YAML frontmatter
  and markdown body. Used automatically inside overnight pipeline turns.
---

# Checkpoint

Write a checkpoint file at the end of every round. The orchestrator provides the filename via the prompt.

```
checkpoint_file = from prompt (e.g. ".overnight/checkpoint-2026-03-24-11-45-58-003.md")

do("complete assigned work first, then write checkpoint")

Write(checkpoint_file, content below)
```

## Format

The checkpoint has two parts: YAML frontmatter (machine-readable) and markdown body (human-readable).

```markdown
---
status: STEP_IN_PROGRESS
step: <step name from prompt>
round: <round number from prompt>
---

## Done

What was accomplished this round. File paths changed, functions added or modified.

## Decisions

Choices made and why. "Used middleware pattern because X." Include alternatives considered.

## Frictions

What was harder than expected. Unexpected couplings, missing docs, unclear APIs, slow tests.

## Next

Concrete next actions, ordered by priority. Each item should be actionable by a fresh agent with no prior context beyond this checkpoint and the codebase.

## Open questions

Questions that could not be resolved from the codebase alone. Be specific:

- "Does UserService.validate() check email format or just presence?"
- "What rate limit does the external payments API enforce?"

Leave empty if no questions remain.
```

## Status values

- `STEP_COMPLETE`: all acceptance criteria from the prompt are met. Work is done.
- `STEP_IN_PROGRESS`: progress was made but work remains. List remaining items in ## Next.
- `STEP_FAILED`: the task is blocked and cannot proceed. Explain the blocker in ## Frictions.
