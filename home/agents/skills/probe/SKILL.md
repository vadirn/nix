---
name: probe
description: >
  Systematically interrogate a plan or design until every decision branch is resolved. Use when user invokes /probe or wants to stress-test a plan, poke holes in a design, find weaknesses in a proposal, get grilled on their approach, or asks "what am I missing". For open-ended comparisons, use debate instead. Probe requires a concrete plan as input.
---

# Probe

Thin wrapper: the doctrine lives in the vault note `Probe`. Load it at invocation — never run from memory of it.

## Parameters

- `plan` (required): The plan or design to probe. Can be inline text, a file path, or context from conversation.
- `depth=shallow|deep`: How many branches to explore (default: deep)

```
plan = <plan> parameter, or conversation context
if no plan provided: AskUserQuestion("What plan or design should I probe?")
depth = <depth> parameter, default "deep"

// Load doctrine
note_path = Bash(vault-query get "Probe")
if note_path missing or ambiguous: do("report the error to the user"); stop

// (parallel)
rules = Bash(vault-query read <note_path> 0)
workflow = Bash(vault-query read <note_path> "Workflow")
output = Bash(vault-query read <note_path> "Output")
if any read errors: do("report the exact error and note_path to the user"); stop

// Probe
do("follow rules + workflow as internal instructions, with <plan> and <depth> bound")
do("structure the final answer per the fenced specimen in output")
```

## Reference

### Doctrine loading

- `vault-query get "Probe"` resolves the note; the exact basename match `Probe.md` is the intended target.
- Structured reads (`vault-query read` with addresses) load only the intro rules (address `0`), the workflow, and the output contract, keeping the note's frontmatter and unresolved questions out of context.
- Fail loud, never improvise: on any resolution or address error the doctrine has moved or its headings were renamed — a workflow reconstructed from memory looks like success while silently degrading the contract. The section headings `Workflow` / `Output` are part of this wrapper's contract with the note.
