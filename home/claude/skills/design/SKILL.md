---
name: design
description: >
  Generate multiple radically different designs for a module, interface, data model,
  or system using parallel sub-agents. Use when user invokes /design or wants to
  explore options, see alternative approaches, "design it twice", compare different
  architectures, or asks "what are my options for". Do NOT use for comparing existing
  options (that's debate) or stress-testing a chosen design (that's probe).
---

# Design

Generate radically different designs, then compare. Based on Ousterhout's "Design It Twice": your first idea is unlikely to be the best.

## Parameters

- `topic` (required): What to design. Can be inline text, a file path, or context from conversation.
- `domain=auto`: cli|api|data|config|pipeline|general (default: auto-detect from topic)
- `count=3`: Number of designs to generate (minimum 3)

```
topic = parse from arguments or conversation context
if no topic: AskUserQuestion("What should I design?")

domain = parse domain= parameter, or auto-detect from topic
count = parse count= parameter, default 3

// Phase 1: Determine constraints
if domain == "general" or auto-detect fails:
    do("probe user: what problem does this solve? who are the callers?")
    do("probe user: what are the key operations? any constraints?")
    do("probe user: what should be hidden inside vs exposed?")
    do("derive constraint set from answers")
    constraints = derived constraints
else:
    constraints = load predefined set for domain

// Phase 2: Generate designs (parallel sub-agents)
(parallel) for each constraint in constraints[:count]:
    Agent("design <topic> under constraint: <constraint>")
    do("output: signature, usage example, what it hides, tradeoffs")

// Phase 3: Present designs
for each design:
    do("show interface signature or schema")
    do("show usage example from caller's perspective")
    do("explain what complexity this design hides internally")
    do("name the tradeoffs explicitly")

// Phase 4: Compare
do("compare designs on: simplicity, generality, depth, ease of correct use")
do("highlight where designs diverge most")

// Phase 5: Synthesize
do("recommend which design fits best, or how to combine insights")
do("suggest /probe to stress-test the chosen design")
```

## Reference

### Predefined constraint sets

**api** (module/library interfaces):

1. Minimize method count: aim for 1-3 methods max
2. Maximize flexibility: support many use cases via composition
3. Optimize for the most common case: make the easy thing easy
4. Paradigm-inspired: take cues from a specific well-known library

**data** (data models, schemas, storage):

1. Fully normalized: no redundancy, strict referential integrity
2. Denormalized for reads: optimize query patterns, accept write complexity
3. Event-sourced: store events, derive state
4. Document-oriented: self-contained documents, embed related data

**cli** (command-line interfaces):

1. Minimal flags: fewest possible options, sensible defaults
2. Subcommand-heavy: git-style verb hierarchy
3. Pipeline-composable: stdin/stdout, unix philosophy
4. Interactive-first: prompts, wizards, progressive disclosure

**config** (configuration formats):

1. Flat key-value: simple, greppable, env-var compatible
2. Nested hierarchy: YAML/TOML-style structured config
3. Convention-over-configuration: minimal config, derive from structure
4. Schema-driven: JSON Schema validated, self-documenting

**pipeline** (workflow/orchestration):

1. Sequential steps: simple ordered list
2. DAG: directed acyclic graph with explicit dependencies
3. Event-driven: steps trigger on events/conditions
4. Actor-based: independent agents communicating via messages

### Evaluation criteria (Ousterhout)

**Interface simplicity**: fewer methods, simpler params = easier to learn and use correctly.

**Depth**: small interface hiding significant complexity = deep module (good). Large interface with thin implementation = shallow module (avoid).

**Ease of correct use vs ease of misuse**: can the caller use it wrong? How hard is it to get right?

**General-purpose vs specialized**: can it handle future use cases? Stay grounded in actual use cases.

### Anti-patterns

- Designs that are superficially different but structurally identical
- Skipping the comparison: the value is in contrast
- Evaluating based on implementation effort rather than interface quality
- Implementing during design: this skill is about shape, not code

### Boundary with other skills

- `/debate`: argues both sides of an open question ("is X better than Y?")
- `/design`: generates multiple concrete solutions before you commit
- `/probe`: stress-tests a chosen design after you pick one
