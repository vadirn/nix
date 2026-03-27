---
name: probe
description: >
  Systematically interrogate a plan or design until every decision branch is resolved.
  Use when user invokes /probe or wants to stress-test a plan, poke holes in a design,
  find weaknesses in a proposal, get grilled on their approach, or asks "what am I missing".
  For open-ended comparisons, use debate instead. Probe requires a concrete plan as input.
---

# Probe

Systematic interrogation of a plan or design. Walk every decision branch, pose hard questions, provide recommended answers.

## Parameters

- `plan` (required): The plan or design to probe. Can be inline text, a file path, or context from conversation.
- `depth=shallow|deep`: How many branches to explore (default: deep)

```
plan = parse plan from arguments or conversation context
if no plan provided: AskUserQuestion("What plan or design should I probe?")

if plan references files or codebase:
    do("read referenced files to ground questions in actual code")

// Phase 1: Map the decision tree
do("identify all decision branches in the plan")
do("order branches by dependency: resolve prerequisites first")

// Phase 2: Walk each branch
for each branch:
    do("pose a specific, pointed question about this branch")
    do("provide a recommended answer grounded in the plan and codebase")
    if answer can be verified from code:
        do("explore codebase to verify or challenge the assumption")
    do("note whether the branch is resolved or needs user input")

// Phase 3: Summarize
do("list resolved decisions with their answers")
do("list unresolved items that need user input")
do("flag any contradictions between branches")
```

## Reference

### What makes a good probe question

A probe question targets a specific decision point, not a vague concern. It names the tradeoff and its consequences.

Weak: "Have you thought about error handling?"
Strong: "When Redis is unreachable, do you fall back to the database (adding latency) or return a cache miss error (breaking clients that expect data)?"

### Recommended answer format

Each question includes a recommended answer. The answer:

1. States the recommended choice
2. Explains why (one sentence)
3. Names the tradeoff accepted

### Output structure

```
## 1. [Question text]

**Recommended:** [Choice]. [Why]. This accepts [tradeoff].

## 2. [Question text]
...

## Summary

### Resolved
- [Decision]: [Choice made]

### Unresolved
- [Decision]: [Why it needs user input]
```

### Boundary with debate

Debate explores open questions from opposing sides ("is X better than Y?").
Probe interrogates a specific plan the user has committed to ("here's my plan, find the holes").

When the user wants to compare options rather than interrogate a chosen plan, suggest /debate instead.
