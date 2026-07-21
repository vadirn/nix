---
name: tdd
description: >
  Test-driven development for agentic coding: one failing test, one implementation, repeat.
  Triggers: /tdd, "write tests first", "test-driven", "TDD", "red green refactor",
  "write a failing test". Skip when testing an existing behavior against a falsifiable
  claim (use /experiment); skip for a feasibility spike with no known design (use /prototype).
---

# TDD Skill

Test-driven development for agentic coding. Tests verify behavior through public interfaces.

## Philosophy

Horizontal slicing (all tests → all code) produces tests that verify imagined behavior.
Vertical slicing (one test → one implementation → repeat) produces tests that verify observed behavior.

Tests written in bulk mock internals, pass trivially, or get rewritten when context runs low. Each test responds to what the previous cycle revealed. See [tests.md](tests.md) for examples.

## Workflow

If already in plan mode, steps 1-2 happen there. Exit plan mode before step 3.

### 1. Load

Read relevant code breadth-first. Then state:

- Files that will change
- Approach in 1-2 sentences
- Open questions

**⏸ Stop.** Present findings. Wait for user to confirm scope or adjust direction.

### 2. Plan

Answer these design questions:

- What interfaces change? What functions, methods, or APIs are added or modified?
- Which behaviors matter most? Prioritize critical paths and complex logic over edge cases.
- How to design for testability? Functions accept dependencies, return results, isolate side effects at boundaries.

Unfamiliar API or system: write a small PoC (10-line script, learning test) to prove assumptions with running code first. Deterministic feedback replaces probabilistic inference.

**⏸ Stop.** Present the plan. Wait for user approval.

### 3. Skeleton

Write types, interfaces, and function signatures across all files. Run typecheck. Signatures only; leave bodies empty.

This establishes the shape of the change before any behavior is added.

**⏸ Stop.** Show the skeleton. Wait for user to review types and signatures.

### 4. TDD Loop

```
ONE test → ONE implementation → repeat
```

Rules:

- Write ONE failing test (RED)
- Write minimal code to pass it (GREEN)
- First cycle is a thin-path test cycle — proves the path works end to end
- **⏸ Stop after the thin-path test cycle.** Show result, confirm direction before continuing.
- Wait for the current test to pass before writing the next one
- Keep implementation focused on the current test only

### 5. Refactor

Only when all tests are green. If a test is red, fix it before refactoring.

Clean up duplication, simplify, improve naming. Run tests after each change.

## UI Components

TDD covers interaction and data flow: click handlers, state changes, conditional rendering, accessibility. Visual correctness (layout, spacing, colors) requires separate review — screenshot, browser, or Storybook. Separate behavioral tests from visual review in step 2 (Plan).

## Continuing

If the conversation already contains context about prior work (checkpoint, summary, or user description), use it to determine the current step. State which step you're resuming at and confirm with the user before proceeding.

Each ⏸ stop is a natural save point. If the project uses checkpoints, note the current step and remaining behaviors when saving.

## Checklist (per cycle)

- [ ] Test describes WHAT, not HOW
- [ ] Test uses public interface only
- [ ] Test fails before implementation (confirmed RED)
- [ ] Implementation is minimal — just enough to pass
- [ ] Only related changes in this cycle
- [ ] All tests pass after implementation (confirmed GREEN)

## Mocking

Mock at system boundaries only: external APIs, databases, time, filesystem. All internal code uses real implementations. See [mocking.md](mocking.md) for details.

## Reference files

Read `tests.md` before writing any test code (step 4 TDD Loop). It contains examples that set the expected style and structure for tests in this project.

Read `mocking.md` when a step raises a boundary or mocking question — typically during step 2 (Plan) when designing for testability, or during step 4 when a boundary crosses into external APIs, databases, time, or the filesystem.
