---
name: debate
description: Structured debate exploring a topic through Defender/Skeptic roles. Use when user invokes /debate or wants to analyze a claim from multiple angles with systematic argumentation. Also use when the user asks for pros and cons, devil's advocate, "argue both sides", steelman/strawman, "is X really better than Y", "convince me", or "arguments for and against". Route to /design when the goal is to generate new concrete solutions from scratch.
---

# Debate

Structured exploration of a topic through opposing viewpoints.

## Parameters

- `topic` (required): Claim or question to debate
- `rounds=N`: Number of rounds (default: 3)
- `lang=en|ru`: Output language (default: auto-detect from topic)

```
lang = <lang> parameter, or do("detect language from topic")
rounds = <rounds> parameter, default 3

// Debate
if lang == "ru":
    Read(dir/workflows/ru.md)
else:
    Read(dir/workflows/en.md)

do("follow loaded workflow as internal instructions, output only the debate rounds and verdict; search for evidence each round as directed by the workflow")
do("cite sources from research as inline links")
do("output each round progressively, one at a time")
if genuine consensus reached: stop early
```

## Reference

### Evidence per round

Each round, each side searches for new evidence. Cite sources as inline links. Keep only results with concrete data (measurements, statistics).
