# Checkpoint format

Write checkpoint files with YAML frontmatter and markdown body.

## Frontmatter

```yaml
---
status: STEP_IN_PROGRESS
step: step-name
round: 1
---
```

`status` must be exactly one of:

- `STEP_COMPLETE`: work meets all criteria, no revisions needed
- `STEP_IN_PROGRESS`: work remains or revisions needed
- `STEP_FAILED`: blocked, cannot proceed

## GP checkpoint (checkpoint-NNN.md)

- `## Plan`: what you intend to do (goals, approach)
- `## Progress`: what you accomplished this round

Always set status `STEP_IN_PROGRESS`. The reviewer decides completion.

If you read `## Feedback` in the review file, address each item before proceeding.

## Skeptic review (review-NNN.md)

- `## Feedback`: specific, actionable review items (name files, functions, issues)

Set status based on your verdict:

- `STEP_COMPLETE` if work meets review criteria
- `STEP_IN_PROGRESS` with concrete feedback if revisions needed
- `STEP_FAILED` if unrecoverable issues
