---
name: affirm
description: >
  Rewrite negative instructions as positive directives and remove hedging language. Use when user invokes /affirm or asks to make instructions direct, remove hedging, flip negatives to positives, or strengthen language in skill files, docs, or prompts. Works on inline text, files, or conversation context. Target instruction and directive text only; route general prose editing to /distill.
---

# Affirm

Thin wrapper: the doctrine lives in the vault note `Affirm`. Load it at invocation — never run from memory of it.

## Parameters

- `text` (required): The text to rewrite. Inline text, file path, or conversation context.

```
text = <args> or conversation context
if no text provided: AskUserQuestion("What text should I rewrite?")

// Load doctrine
note_path = Bash(vault-query get "Affirm")
if note_path missing or ambiguous: do("report the error to the user"); stop

// (parallel)
rules = Bash(vault-query read <note_path> 0)
transforms = Bash(vault-query read <note_path> "Transforms")
negatives = Bash(vault-query read <note_path> "Negative to positive")
hedging = Bash(vault-query read <note_path> "Hedging to direct")
doubles = Bash(vault-query read <note_path> "Double negatives")
permission = Bash(vault-query read <note_path> "Permission framing")
conditionals = Bash(vault-query read <note_path> "Vacuous conditionals")
if any read errors: do("report the exact error and note_path to the user"); stop

// Apply
if text looks like a file path (starts with / or ./, ends with a known extension, or matches an existing file):
  read the file at that path  // Read file content
  do("apply transforms to the file content, calibrating each pass against its specimen section")
  write the result back to the same path  // Write result back
  show a summary of changes made
else:
  do("apply rules + transforms with <text> bound, calibrating each pass against its specimen section")
  do("emit the result per the verify and output steps in transforms")
```

## Reference

### Doctrine loading

- `vault-query get "Affirm"` resolves the note; the exact basename match `Affirm.md` is the intended target.
- Structured reads (`vault-query read` with addresses) load only the intro rules (address `0`), the transform passes, and the five specimen sections, keeping the note's frontmatter out of context.
- Fail loud, never improvise: on any resolution or address error the doctrine has moved or its headings were renamed — a workflow reconstructed from memory looks like success while silently degrading the contract. The section headings `Transforms` / `Negative to positive` / `Hedging to direct` / `Double negatives` / `Permission framing` / `Vacuous conditionals` are part of this wrapper's contract with the note.
