---
name: pseudocode
description: >
  Convert freeform workflow instructions into structured pseudocode for Claude Code skills.
  Use when writing or rewriting SKILL.md files, when the user says "write pseudocode",
  "convert to pseudocode", "make this a skill", or when refactoring skill instructions
  from prose to structured form. Also use when reviewing existing skill pseudocode for
  consistency with conventions.
---

# Pseudocode

Convert freeform workflow text into structured pseudocode block + Reference section.

## Syntax

There are three types of lines in pseudocode:

**Calls** execute tools or delegate freeform work:

```
result = Bash(git status)
Skill(commit)
AskUserQuestion("Update or stop?")
do("summarize errors, categorize mechanical vs semantic")
title, body = do("generate from diff and log")
```

**Logic** encodes decisions and flow:

```
if branch == default_branch: stop
if no upstream: Bash(git push -u origin <branch>)
else if ahead: Bash(git push)
```

**Comments** label sections only:

```
// Guards
// Push if needed
```

## Conventions

- **Guard clauses early.** Stop conditions before the happy path. Reduces nesting.
- **Parallelism is explicit.** Mark `(parallel)` when calls are independent and should run together.
- **Tool calls are literal.** `Bash(...)`, `Skill(...)`, `AskUserQuestion(...)` are real instructions.
- **`do()` for freeform directives.** When the step is "use your judgment", wrap it in `do()`. This distinguishes LLM-directed work from mechanical tool calls.
- **Variable names carry intent.** `default_branch` not `db`. The model reads these as semantic hints.
- **No numbered steps.** Sequence is implicit from order.
- **Comments label sections only.** Never comment-only steps. If a line is only a comment, it should be a section label or it should be rewritten as a call, assignment, or logic.
- **Details live in Reference.** The pseudocode block shows WHAT happens and WHEN. The Reference section explains HOW and WHY.

## Process

```
input = freeform workflow text

// Identify structure
steps = do("extract discrete steps from input")
decisions = do("find branching points, stop conditions, error cases")
tools = do("identify which steps are tool calls vs freeform directives")

// Write pseudocode
do("order steps: gather state, guards, happy path, output")
do("use `do()` for freeform directives, literal calls for tools")
do("mark parallel groups")

// Write Reference section
do("move format specs, examples, and explanations out of pseudocode into Reference")
```

## Example

**Input:**

> First check git status and what branch we're on. If we're on main, stop.
> If there are uncommitted changes, run the commit skill.
> Then push the branch and create a PR with a good title and description.

**Output:**

````
## Create flow

```
// Gather state (parallel)
status = Bash(git status)
branch = Bash(git rev-parse --abbrev-ref HEAD)

// Guards
if branch == "main": stop
if uncommitted changes in status: Skill(commit), then stop

Bash(git push -u origin <branch>)
title, body = do("generate title and body from branch commits")
Bash(gh pr create --title "<title>" --body "<body>" --draft)
```

## Reference

### PR title and body

- Title: <70 chars, conventional commit style
- Body: `## Summary` bullets + `## Test plan` checklist
````
