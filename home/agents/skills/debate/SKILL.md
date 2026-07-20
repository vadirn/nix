---
name: debate
description: Structured debate exploring a topic through Defender/Skeptic roles. Use when user invokes /debate or wants to analyze a claim from multiple angles with systematic argumentation. Also use when the user asks for pros and cons, devil's advocate, "argue both sides", steelman/strawman, "is X really better than Y", "convince me", or "arguments for and against". Route to /design when the goal is to generate new concrete solutions from scratch.
---

# Debate

Thin wrapper: the doctrine lives in the vault note `Debate`. Load it at invocation — never run from memory of it.

## Parameters

- `topic` (required): Claim or question to debate
- `rounds=N`: Number of rounds (default: 3)
- `lang=en|ru`: Output language (default: auto-detect from topic)

```
lang = <lang> parameter, or do("detect language from topic")
rounds = <rounds> parameter, default 3
section = "Workflow (EN)" if lang == "en" else "Workflow (RU)"

// Load doctrine
note_path = Bash(vault-query get "Debate")
if note_path missing or ambiguous: do("report the error to the user"); stop

// (parallel)
rules = Bash(vault-query read <note_path> 0)
workflow = Bash(vault-query read <note_path> "<section>")
if either read errors: do("report the exact error and note_path to the user"); stop

workflow = do("substitute <rounds> and <topic> in the fenced specimen")

// Debate
do("follow rules + workflow as internal instructions; output only the debate rounds and verdict")
do("search for evidence each round; cite sources as inline links")
do("output each round progressively, one at a time")
if genuine consensus reached: stop early
```

## Reference

### Doctrine loading

- `vault-query get "Debate"` resolves the note; the exact basename match `Debate.md` is the intended target.
- Structured reads (`vault-query read` with addresses) load only the intro rules (address `0`) and the invoked language's workflow, keeping the other language and the note's frontmatter out of context.
- Fail loud, never improvise: on any resolution or address error the doctrine has moved or its headings were renamed — a workflow reconstructed from memory looks like success while silently degrading the contract. The section headings `Workflow (EN)` / `Workflow (RU)` are part of this wrapper's contract with the note.

### Evidence per round

Each round, each side searches for new evidence. Cite sources as inline links. Keep only results with concrete data (measurements, statistics).
