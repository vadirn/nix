---
name: grade
description: >
  Grade a decision/recommendation/claim on a 1-10 confidence scale. Use on /grade or "rate confidence in X".
  Open questions → /debate; plan stress-test → /probe.
  Skip when the claim is empirically testable by running a command (use /experiment).
---

# Grade

Evaluate a decision, recommendation, or claim on a 1-10 confidence scale.

## Parameters

- `claim` (required): The decision, recommendation, or claim to grade. Inline text, file path, or conversation context.
- `mode=quick|detailed|auto` (optional): Force output mode. Default: auto (simple claims get quick, complex decisions get detailed).

```
claim = <arguments or conversation context>
if no claim provided: AskUserQuestion("What decision or recommendation should I grade?")

// Determine mode
if mode parameter provided: use that mode
else if claim is simple: mode = "quick"
else: mode = "detailed"

// Restate
do("restate the claim in one sentence, removing ambiguity")
do("identify the implicit assumptions the claim rests on")

// Evaluate
factors = do("identify the 2-4 factors that most affect confidence in this claim")

if mode == "quick":
    do("evaluate each factor in a sentence")
else:
    do("evaluate each factor in 1-2 sentences, with strong/mixed/weak assessment")

// Synthesize
grade = do("assign a grade from 1 to 10")
do("state the single biggest risk that could lower the grade")
next_step = do("name one concrete action to resolve the biggest unknown")
if no concrete action exists: do("say the uncertainty is inherent and why")
```

## Grading scale

The scale is absolute. A grade reflects how confident you are that the claim is correct or the decision is sound, given current information.

- **9-10**: Near-certain. Strong evidence, low risk, well-understood domain. Wrong only if assumptions are violated.
- **7-8**: Confident. Good evidence, manageable risk. A few unknowns remain but the direction is sound.
- **5-6**: Plausible. Mixed evidence or significant unknowns. Could go either way depending on conditions not yet verified.
- **3-4**: Uncertain. Weak evidence, high risk, or the claim rests on assumptions you cannot verify.
- **1-2**: Unlikely. Contradicts available evidence or depends on conditions that are probably false.

## Output format

**Quick mode** (simple claims):

```
**Grade: N/10** — one-sentence summary

Key factors: 2-3 sentences covering the relevant dimensions.
Risk: what could go wrong. Next step: one concrete action to resolve the biggest unknown.
```

**Detailed mode** (complex decisions):

```
**Claim**: restated claim

| Factor | Assessment | Reasoning |
|--------|------------|-----------|
| (derived from claim) | strong/mixed/weak | ... |
| ... | ... | ... |

**Grade: N/10** — synthesis explaining which dimensions weigh most and why

**Risk**: the single biggest threat to this grade
**Next step**: one concrete action to resolve the biggest unknown
```

## Self-grading

When grading your own recommendation mid-conversation, always use quick mode. The inline one-liner format fits conversation flow. The full detailed breakdown is for when the user explicitly asks `/grade`.

Calibrate grades to match actual confidence. A grade of 5 with clear reasoning helps the user more than an inflated 8. State domain uncertainty explicitly and suggest how to verify.

## Reference

### Mode classification

"Simple" means a single-variable choice or factual assertion (e.g., "use JSON for config"). "Complex" means multiple interacting concerns (e.g., "migrate from REST to GraphQL"). When ambiguous, prefer detailed.

### Deriving factors

Start from the claim, not from a checklist. Common factors include evidence strength, reversibility, blast radius, domain fit, alternatives considered, and unverified dependencies. But time pressure, team capability, political constraints, or cost may matter more for a given claim. Name whatever actually drives confidence.

### Next step

A concrete action: a command to run, a metric to check, a person to ask. Specific moves like "run `fio --randwrite` on the target disk and check if it exceeds 500 IOPS" rather than vague ones like "get more data." If the uncertainty is inherent (no action can reduce it), say so and explain why.
