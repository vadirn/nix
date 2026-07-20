---
name: design
description: >
  Generate multiple radically different designs for a module, interface, or system using parallel subagents. Triggers: /design, "design it twice", "what are my options for", "compare architectures". Skip when comparing existing options (use /debate) or stress-testing one plan (use /probe).
---

# Design

Thin wrapper: the doctrine lives in the vault note `Design`. Load it at invocation — never run from memory of it.

## Parameters

- `topic` (required): What to design. Can be inline text, a file path, or context from conversation.
- `domain=auto`: cli|api|data|config|pipeline|general (default: auto-detect from topic)
- `count=4`: Number of designs to generate (minimum 3)

```
topic = <topic> from arguments or conversation context
if no topic: AskUserQuestion("What should I design?")
count = <count> parameter, default 4

// Load doctrine
note_path = Bash(vault-query get "Design")
if note_path missing or ambiguous: do("report the error to the user"); stop

// (parallel)
rules = Bash(vault-query read <note_path> 0)
constraint_rules = Bash(vault-query read <note_path> "Constraints")
per_design = Bash(vault-query read <note_path> "Per-design output")
comparison = Bash(vault-query read <note_path> "Comparison")
synthesis = Bash(vault-query read <note_path> "Synthesis")
antipatterns = Bash(vault-query read <note_path> "Anti-patterns")
if any read errors: do("report the exact error and note_path to the user"); stop

// Determine constraints
domain = <domain> parameter, or do("auto-detect from topic against the keyword mapping in constraint_rules")
if domain == "general" or auto-detect fails:
    constraints = do("derive a constraint set by probing the user per constraint_rules")
else:
    sets = Bash(vault-query read <note_path> "Predefined constraint sets")
    constraints = do("take the <domain> set from sets")

// Generate designs (parallel sub-agents)
count = min(count, len(constraints))   // cap so a user-supplied count never exhausts the set silently
(parallel) for each constraint in constraints[:count]:
    spawn_subagent("design <topic> under constraint: <constraint>", payload = per-design contract from per_design)

// Present, compare, synthesize
do("present each design per per_design, compare per comparison, close per synthesis; rules and antipatterns bind throughout")
```

## Reference

### Doctrine loading

- `vault-query get "Design"` resolves the note; the exact basename match `Design.md` is the intended target.
- Structured reads (`vault-query read` with addresses) load only the intro (address `0`), the constraint rules, the per-design contract, the comparison criteria, the synthesis step, and the anti-patterns, keeping the note's frontmatter out of context. `Predefined constraint sets` is read only when a domain matches, so unused sets stay out of context.
- Fail loud, never improvise: on any resolution or address error the doctrine has moved or its headings were renamed — a workflow reconstructed from memory looks like success while silently degrading the contract. The section headings `Constraints` / `Predefined constraint sets` / `Per-design output` / `Comparison` / `Synthesis` / `Anti-patterns` are part of this wrapper's contract with the note.
