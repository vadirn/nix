# Chart — bootstrap a new goal

Turn a foggy aim into a crux goal and its first frontier. Charting is one session's work. It resolves no question by hand beyond what the destination needs.

## Pseudocode

```
// 1. Fix the destination with the cheapest matched instrument
destination = do("state the end state in 1-2 sentences: disputable, with a measurable done-condition")
while destination is too fuzzy to fix:
    kind = do("classify the fuzziness: preference | fact | reality")
    if kind == preference:  do("grill: ask the sharpening question")       // cheapest, try first
    if kind == fact:        do("/research \"<the open fact>\"")
    if kind == reality:     do("run one small recon step that raises clarity")
    if de-fuzzing exceeds its time-box:
        do("stop: the aim is not map-ready. Offer `create_item(kind: seed, parent: project)`. Halt.")

// 2. Select the rung: one bounded sweep, distinct from ongoing charting
sweep = do("list every open item ONCE, type each (decision/fact/feasibility/work), mark what blocks what,
            leave the unphrasable as fog. The cap is coverage, not a clock")
rung = do("apply the Planning.md escalation ladder to what the sweep revealed")
if rung < 4:                       // no fog, one session, under ~12 nodes, or items are changes not decisions
    do("do NOT chart. Route to the rung's native artifact, or file the items as work under a plain goal. Halt.")

// 3. Read reversibility per node: ordering, and whether a Frame is needed
ordering = do("any swept node high blast-radius AND expensive to undo → risk; else → dependency")
if ordering == risk:
    prior = Bash(vault-query consult "<aim> — appetite, capability, tolerance for loss" --format markdown)
    frame = do("build the Frame from prior thinking plus a short grill: appetite with a dated walk-away floor,
                capability. Paths beyond capability are dropped, not fogged")

// 4. Create the goal
goal = create_item(kind: "goal", parent: project, title, result: destination,
                   body: destination prose + (frame as `## Frame` if risk-ordered) + `## Out of scope`)

// 5. Create the questions you can phrase now, then wire them
for each swept item phrased as a sharp question:
    create_item(kind: "question", parent: goal, title, facet, risk: (risk-ordered only), body)
crux = do("risk-ordered only: pick the crux; /grade the choice, /debate the top two under 7 or tied")
    // set `crux: true` at creation. It cannot change later, so decide before the call.
for each blocking pair: link(from, to, "requires")           // second pass: items need ids first
for each fog patch: create_item(kind: "seed", parent: goal, title, body)   // unsliced
for each fact question: do("/research \"<question>\" in parallel; write findings with add_note(question, observation)")

// 6. Stop: write the bookmark, hand nothing off
add_note(goal, "observation", do("questions created, the frontier (`frontier(goal)`), what blocks what,
                                  the next takeable question"))
do("list unresolved questions. Halt: resolving is references/work.md")
```

## Reference

### Fixing the destination

The destination fixes scope, so settle it first. It must be disputable and carry a measurable done-condition: "$1,000 recurring monthly revenue, net of refunds, sustained two consecutive months", not "make money on the side". A crux charts backward from the destination, so a fuzzy destination leaves the spine unanchored. The `result` field is required on a goal and carries it.

De-fuzzing is instrument-per-uncertainty-type, aimed at the destination. Preference fuzziness takes a grill. Fact fuzziness takes `/research`. Reality fuzziness takes one small probe. Escalate only when the cheaper move stops raising clarity. Time-box the loop, and park a stubborn aim as a seed rather than forcing a spine onto fog.

### Picking the rung

The sweep selects the rung. Climb to rung 4 only when the aim is fogged and larger than one session: a graph over about 12 nodes, or open items that are decisions rather than changes. Below that, a map is the ceremony `Planning.md` forbids. Absorbing a rung-4 problem into a lower rung converts an estimate into a lie.

### Facets and edges

Set the facet at creation, because it cannot change. Create questions first, then wire `requires` edges in a second pass, since an edge needs both ids. A cycle is refused and the error names both ends. Everything you cannot phrase as a sharp question stays a seed. Do not pre-slice the fog, because one patch may graduate into several questions, or none, once the frontier reaches it.

### The Frame

Build a Frame only for a risk-ordered goal. Seed it with `/consult`, since the user's self-knowledge notes usually hold half of it. Write the walk-away floor as a pre-committed, dated kill-condition in the goal body, so moving it later is a visible `update_body`, not a quiet drift under sunk cost.
