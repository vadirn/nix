---
name: debate
description: Structured debate exploring a topic through Defender/Skeptic roles. Use when user invokes /debate or wants to analyze a claim from multiple angles with systematic argumentation.
---

# Debate

Structured exploration of a topic through opposing viewpoints.

## Parameters

- `topic` (required): Claim or question to debate
- `rounds=N`: Number of rounds (default: 7)
- `lang=en|ru`: Output language (default: auto-detect from topic)

## Process

1. Parse parameters
2. Load `workflows/en.md` or `workflows/ru.md` based on language
3. Follow loaded workflow template
4. Use WebSearch and firecrawl to find evidence supporting arguments
5. Output each round progressively (don't batch)
6. Stop early if genuine consensus reached
