---
name: debate
description: Structured debate exploring a topic through Defender/Skeptic roles. Use when user invokes /debate or wants to analyze a claim from multiple angles with systematic argumentation. Also use when the user asks for pros and cons, devil's advocate, "argue both sides", steelman/steelman, "is X really better than Y", "convince me", or "arguments for and against".
---

# Debate

Structured exploration of a topic through opposing viewpoints.

## Parameters

- `topic` (required): Claim or question to debate
- `rounds=N`: Number of rounds (default: 7)
- `lang=en|ru`: Output language (default: auto-detect from topic)

```
lang = detect from topic, or parse lang= parameter
rounds = parse rounds= parameter, default 7

if lang == "ru":
    Read(dir/workflows/ru.md)
else:
    Read(dir/workflows/en.md)

follow loaded workflow template
do("use firecrawl to find evidence supporting arguments")
do("output each round progressively, don't batch")
if genuine consensus reached: stop early
```
