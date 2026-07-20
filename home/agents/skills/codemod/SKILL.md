---
name: codemod
description: Codemod-first refactor pattern. Use when a refactor touches more than 20 files, when renaming across packages, when changing a function signature used everywhere, or when migrating between library versions.
---

# Codemod

Thin wrapper: the doctrine lives in the vault note `Codemod`. Load it at invocation — never run from memory of it.

```
task = the refactor to perform (transform and scope), from the user's request or conversation context

// Load doctrine
note_path = Bash(vault-query get "Codemod")
if note_path missing or ambiguous: do("report the error to the user"); stop

// (parallel)
rules = Bash(vault-query read <note_path> 0)
decision = Bash(vault-query read <note_path> "Decision")
tools = Bash(vault-query read <note_path> "Tool choice")
procedure = Bash(vault-query read <note_path> "Procedure")
antipatterns = Bash(vault-query read <note_path> "Anti-patterns")
if any read errors: do("report the exact error and note_path to the user"); stop

// Refactor
do("judge <task> against decision; if a codemod is not warranted, say so and stop")
do("pick the tool per tools, then execute procedure with <task> bound, holding antipatterns as constraints throughout")
```

## Reference

### Doctrine loading

- `vault-query get "Codemod"` resolves the note; the exact basename match `Codemod.md` is the intended target.
- Structured reads (`vault-query read` with addresses) load only the intro (address `0`), the decision rule, the tool choice, the procedure, and the anti-patterns, keeping the note's frontmatter out of context.
- Fail loud, never improvise: on any resolution or address error the doctrine has moved or its headings were renamed — a procedure reconstructed from memory looks like success while silently degrading the contract. The section headings `Decision` / `Tool choice` / `Procedure` / `Anti-patterns` are part of this wrapper's contract with the note.
