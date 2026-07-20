---
name: pseudocode
description: >
  Convert freeform workflow text into structured pseudocode for SKILL.md files. Triggers: /pseudocode, "write pseudocode", "convert to pseudocode", "make this a skill", or converting a SKILL.md prose procedure into a pseudocode block. Skip when the goal is to create or iterate on a skill holistically (use skill-creator).
---

# Pseudocode

Thin wrapper: the doctrine lives in the vault note `Pseudocode`. Load it at invocation — never run from memory of it.

```
input = freeform workflow text from the invocation, a named file, or conversation context

// Load doctrine
note_path = Bash(vault-query get "Pseudocode")
if note_path missing or ambiguous: do("report the error to the user"); stop

// (parallel)
intro = Bash(vault-query read <note_path> 0)
syntax = Bash(vault-query read <note_path> "Syntax")
conventions = Bash(vault-query read <note_path> "Conventions")
process = Bash(vault-query read <note_path> "Process")
example = Bash(vault-query read <note_path> "Example")
if any read errors: do("report the exact error and note_path to the user"); stop

// Convert
do("follow process as internal instructions, with <input> bound")
do("write every line per syntax and conventions; shape the result like example")
```

## Reference

### Doctrine loading

- `vault-query get "Pseudocode"` resolves the note; the exact basename match `Pseudocode.md` is the intended target.
- Structured reads (`vault-query read` with addresses) load only the intro gloss (address `0`), the syntax, the conventions, the process, and the worked example, keeping the note's frontmatter out of context.
- Fail loud, never improvise: on any resolution or address error the doctrine has moved or its headings were renamed — a conversion reconstructed from memory looks like success while silently degrading the contract. The section headings `Syntax` / `Conventions` / `Process` / `Example` are part of this wrapper's contract with the note.
