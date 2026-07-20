---
name: justify
description: >
  Demand a sufficient reason for each element (code, plan step, or action) and recommend cutting whatever cannot earn its place. Use on /justify: defaults to the working-tree diff, "justify actions" audits the recent action transcript, or pass a file path or plan to audit that. Also triggers on: "does this need to be here", "is this justified", "what can we cut", "does this carry dead weight", "audit this diff", "is this code/step/action necessary". To stress-test a plan's decisions use /probe; for code cleanups that assume the code should stay use /simplify.
---

# Justify

Thin wrapper: the doctrine lives in the vault note `Justify`. Load it at invocation — never run from memory of it.

## Parameters

- `target` (optional): What to audit. Inline text, a file path, the word `actions` (or `transcript`), or empty. Empty defaults to the working-tree diff. Conversation context is used when it carries the plan.

```
target = <args> or working-tree diff
if no args and the working-tree diff is empty: AskUserQuestion("Nothing staged or unstaged to audit. Justify this session's actions, or a plan/file path?"), then stop

// Resolve the mode
if target in {"actions","transcript"}: mode = actions
else if target is a file path, inline prose, or a plan in context: mode = text
else: mode = diff

// Load doctrine
note_path = Bash(vault-query get "Justify")
if note_path missing or ambiguous: do("report the error to the user"); stop

// (parallel)
rules = Bash(vault-query read <note_path> 0)
workflow = Bash(vault-query read <note_path> "Workflow")
terms = Bash(vault-query read <note_path> "Terms")
independence = Bash(vault-query read <note_path> "Independence")
keep_guardrails = Bash(vault-query read <note_path> "What to keep")
output = Bash(vault-query read <note_path> "Output")
if any read errors: do("report the exact error and note_path to the user"); stop

// Audit
do("follow rules + workflow as internal instructions, with <target> and <mode> bound; terms, independence, and keep_guardrails govern the test")
do("structure the final answer per the fenced specimen in output")
```

## Reference

### Doctrine loading

- `vault-query get "Justify"` resolves the note; the exact basename match `Justify.md` is the intended target.
- Structured reads (`vault-query read` with addresses) load the intro rules (address `0`) and each named section, keeping the note's frontmatter out of context.
- Fail loud, never improvise: on any resolution or address error the doctrine has moved or its headings were renamed — a test reconstructed from memory looks like success while silently degrading the contract. The section headings `Workflow` / `Terms` / `Independence` / `What to keep` / `Output` are part of this wrapper's contract with the note.
