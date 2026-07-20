---
name: tdd
description: >
  Test-driven development for agentic coding: one failing test, one implementation, repeat. Triggers: /tdd, "write tests first", "test-driven", "TDD", "red green refactor", "write a failing test". Skip when testing an existing behavior against a falsifiable claim (use /experiment); skip for a feasibility spike with no known design (use /prototype).
---

# TDD

Thin wrapper: the doctrine lives in the vault note `Implementation`. Load it at invocation — never run from memory of it.

```
// Load doctrine
note_path = Bash(vault-query get "Implementation")
if note_path missing or ambiguous: do("report the error to the user"); stop

// (parallel)
rules = Bash(vault-query read <note_path> 0)
forces = Bash(vault-query read <note_path> "Forces (basis for every step)")
preferences = Bash(vault-query read <note_path> "Preferences (recorded choices; treat as rules)")
overrides = Bash(vault-query read <note_path> "Repo-local overrides")
process = Bash(vault-query read <note_path> "Process")
state = Bash(vault-query read <note_path> "State file")
if any read errors: do("report the exact error and note_path to the user"); stop

// Implement
do("follow process as internal instructions; forces justify each step, preferences and overrides govern choices, state governs resuming")
if already in plan mode: do("run process steps 1-2 in plan mode; exit plan mode before step 3")
```

## Reference files

Read `tests.md` before writing any test code (process step 4). It contains examples that set the expected style and structure for tests in this project.

Read `mocking.md` when a step raises a boundary or mocking question — typically during step 2 (Plan) when designing for testability, or during step 4 when a boundary crosses into external APIs, databases, time, or the filesystem.

## Reference

### Doctrine loading

- `vault-query get "Implementation"` resolves the note; the exact basename match `Implementation.md` is the intended target.
- Structured reads (`vault-query read` with addresses) load the intro (address `0`) and each named section — everything except the note's own Unresolved-questions housekeeping.
- Fail loud, never improvise: on any resolution or address error the doctrine has moved or its headings were renamed — a process reconstructed from memory looks like success while silently degrading the contract. The section headings named above are part of this wrapper's contract with the note.
