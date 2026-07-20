---
name: grade
description: >
  Grade a decision/recommendation/claim on a 1-10 confidence scale. Use on /grade or "rate confidence in X". Skip when the user wants both sides argued rather than a single confidence score (use /debate). Skip when the goal is stress-testing a plan for holes (use /probe). Skip when the claim is empirically testable by running a command (use /experiment).
---

# Grade

Thin wrapper: the doctrine lives in the vault note `Grade`. Load it at invocation — never run from memory of it.

## Parameters

- `claim` (required): The decision, recommendation, or claim to grade. Inline text, file path, or conversation context.
- `mode=quick|detailed|auto` (optional): Force output mode. Default: auto (simple claims get quick, complex decisions get detailed).

```
claim = <claim> parameter, or conversation context
if no claim provided: AskUserQuestion("What decision or recommendation should I grade?")
mode = <mode> parameter, default "auto"

// Load doctrine
note_path = Bash(vault-query get "Grade")
if note_path missing or ambiguous: do("report the error to the user"); stop

// (parallel)
rules = Bash(vault-query read <note_path> 0)
workflow = Bash(vault-query read <note_path> "Workflow")
scale = Bash(vault-query read <note_path> "Scale")
output = Bash(vault-query read <note_path> "Output")
if any read errors: do("report the exact error and note_path to the user"); stop

// Grade
do("follow rules + workflow as internal instructions, with <claim> and <mode> bound")
do("grade against scale; structure the answer per the mode's fenced specimen in output")
```

## Reference

### Doctrine loading

- `vault-query get "Grade"` resolves the note; the exact basename match `Grade.md` is the intended target.
- Structured reads (`vault-query read` with addresses) load only the intro rules (address `0`), the workflow, the scale, and the output contract, keeping the note's frontmatter out of context.
- Fail loud, never improvise: on any resolution or address error the doctrine has moved or its headings were renamed — a workflow reconstructed from memory looks like success while silently degrading the contract. The section headings `Workflow` / `Scale` / `Output` are part of this wrapper's contract with the note.
