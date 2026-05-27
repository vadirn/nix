---
name: debate
description: Structured debate exploring a topic through Defender/Skeptic roles. Use when user invokes /debate or wants to analyze a claim from multiple angles with systematic argumentation. Also use when the user asks for pros and cons, devil's advocate, "argue both sides", steelman/strawman, "is X really better than Y", "convince me", or "arguments for and against". Skip when the goal is to generate new concrete solutions from scratch (use /design).
---

# Debate

Structured exploration of a topic through opposing viewpoints.

## Parameters

- `topic` (required): Claim or question to debate
- `rounds=N`: Number of rounds (default: 7)
- `lang=en|ru`: Output language (default: auto-detect from topic)

```
lang = do("detect language from topic, or parse lang= parameter")
rounds = do("parse rounds= parameter, default 7")

// Research phase (parallel)
results_for = web_search("evidence arguments for: <topic>")
results_against = web_search("evidence arguments against: <topic>")
results_data = web_search("statistics data <topic>")

evidence_base = do("compile search results into structured notes, discard results without concrete data")

if promising URLs in results:
    web_scrape(top 2-3 URLs for deeper evidence)

// Debate phase
if lang == "ru":
    Read(dir/workflows/ru.md)
else:
    Read(dir/workflows/en.md)

do("follow loaded workflow as internal instructions, output only the debate rounds and verdict, use evidence_base as shared context")
do("cite sources from research as inline links")
do("output each round progressively, one at a time")
if genuine consensus reached: stop early
```

## Reference

### Evidence base structure

Each entry in evidence_base contains: claim with source (URL, date), statistics and measurements, counterarguments found. Discard search results that lack concrete data.
