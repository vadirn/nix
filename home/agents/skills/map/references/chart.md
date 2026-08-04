# Chart — bootstrap a new map

Turn a foggy goal into a map and its first frontier. Charting is one session's work. It resolves no nodes by hand beyond what the destination needs.

## Pseudocode

```
cfg = Bash(vault-query config)              // vault_root, project_path; or --project <name>

// 1. Fix the destination — de-fuzz with the cheapest matched instrument
destination = do("state the end state in 1-2 sentences: disputable, with a measurable done-condition")
while destination is too fuzzy to fix:
    kind = do("classify the fuzziness: preference | fact | reality")
    if kind == preference:  do("grill — ask the sharpening question")     // cheapest; try first
    if kind == fact:        do("/research \"<the open fact>\" — depth self-selects")
    if kind == reality:     do("run one small recon step that raises clarity (a /prototype-scale probe)")
    if de-fuzzing exceeds its time-box:
        do("stop: the goal is not map-ready. Offer to park it as a Scratchpad seed (idea, no done-condition). Halt.")

// 2. Select the rung — a one-time bounded sweep, distinct from ongoing charting
sweep = do("bounded breadth-first sweep: list every open item ONCE, type each
            (decision/fact/feasibility/execution), mark what blocks what, fog the unphrasable.
            The cap is coverage, not a clock: stop when every open item is listed and typed.
            Keep fog unsliced — the sweep counts and types, it does not chart")
rung = do("apply the Planning.md escalation ladder to what the sweep revealed")
if rung < 4:                                 // no fog, one session, <~12 nodes, or items are changes not decisions
    do("do NOT build a map. Route to the rung's native artifact (direct execution / breadth-first skeleton /
        probe-then-graph) or hand off. A map on a knowable goal is the ceremony Planning.md forbids. Halt.")

// 3. Read reversibility per node — decide ordering and whether a Frame is needed
ordering = do("if any swept node is high blast-radius AND expensive to undo → 'risk'; else → 'dependency'")
if ordering == risk:
    prior = Bash(vault-query consult "<goal> — appetite, capability, tolerance for loss" --format markdown)
    frame = do("build the Frame from prior thinking + a short grill:
                appetite (what to stake, a pre-committed dated walk-away floor, time budget);
                capability (skills, capital, sustainable hours/energy).
                Send capability-exceeding paths to Out-of-scope, not fog.")

// 4. Create the map and its paired track (eager, so early tickets' track: never dangles)
slug         = AskUserQuestion("slug?", default = do("derive kebab-case slug from the destination"))
map_path     = <cfg.project_path>/map-<slug>.md
track_path   = <cfg.project_path>/track-<slug>.md
project_link = do("read <cfg.project_path>/Context.md for the 'Project note: [[...]]' wikilink, if present")

do("instantiate map-<slug>.md from <cfg.vault_root>/templates/Map.md: frontmatter type/slug/status:open/
    ordering (from step 3)/crux (empty)/project/created/updated; Destination filled; Frame kept if risk-ordered,
    deleted if dependency-ordered; Decisions-so-far empty; the sweep's fog into Not-yet-specified, unsliced;
    Out-of-scope seeded; Backlog empty")

// ADOPT an existing track — never overwrite it (the effort may already have a Log history)
if track-<slug>.md exists:
    do("ADOPT it: set Direction to the Destination only if Direction is empty; append a Log entry noting the
        map was charted; leave the body intact. Never printf over a track that already has Log entries")
else:
    do("instantiate track-<slug>.md from templates/Track.md: Direction = the Destination, empty Log
        (see /track save.md §Frontmatter)")
do("write each NEW file atomically: content > path.tmp, then mv over path")

// 5. Create the nodes you can specify now (create-then-wire)
do("for each swept item you can phrase as a sharp question now, create a typed ticket in Tickets.base with
    kind: <decision|fact|feasibility>, track: track-<slug>, and an empty ## Resolution (see /vault ticket §Map nodes);
    leave the fog as prose in Not-yet-specified")
do("second pass: wire requires: blocking edges (tickets need ids before they can reference each other)")
do("for each fact node, call /research \"<node question>\" (fire-and-forget, in parallel); pass a stakes hint
    when the fact feeds the crux; write the returned findings block into the node's ## Resolution")

// 6. Stop — write the bookmark, hand nothing off
do("write a track Log entry snapshotting: nodes created, the current frontier, what is blocked and on which
    execution tickets, the next takeable node (see references/work.md §Stop)")
do("charting is one session's work. List unresolved questions. Halt — resolving nodes is references/work.md.")
```

## Reference

### Fixing the destination

The destination fixes scope, so settle it first. It must be **disputable** and carry a **measurable done-condition** — "$1,000 recurring monthly revenue, net of refunds, sustained two consecutive months," not "make money on the side." A crux charts backward from the destination. A fuzzy destination leaves the spine unanchored.

De-fuzzing is itself instrument-per-uncertainty-type, aimed at the destination:

- **Preference** fuzziness ("one product or a portfolio?") → grill. Just ask. Cheapest, try first.
- **Fact** fuzziness ("what MRR is realistic here?") → `/research` — it self-selects depth.
- **Reality** fuzziness ("is anything here sellable?") → one small recon probe.

Escalate only when the cheaper move stops raising clarity. Time-box the loop. If it drags, the goal is not map-ready. Park it as a Scratchpad seed rather than forcing a spine onto fog.

### Picking the rung

The sweep selects the rung. The rung is not assumed. Climb to rung 4 (a map) only when the goal is **fogged and larger than one session** — a graph over ~12 nodes, or open items that are decisions rather than changes. Below that, the map is ceremony: route to direct execution, a breadth-first skeleton, or probe-then-graph. Absorbing a rung-4 problem into a lower rung converts an estimate into a lie.

### The Frame

Build a Frame only for a risk-ordered map (see `SKILL.md` §The Frame for why it is the parameter of Force 5, not a new force). Seed it with `/consult`. The user's self-knowledge notes usually hold half of it (a binding time constraint, known biases). Write the walk-away floor as a **pre-committed, dated** kill-condition, so moving it later is a visible edit, not a quiet drift under sunk cost.

### Node types and edges

Type every charting node with `kind:` — decision / fact / feasibility. The type is the instrument (a plain execution step is a `kind: execution` ticket the map does not chart). Create tickets first, each with an empty `## Resolution`, then wire `requires:` edges in a second pass. Everything you cannot phrase as a sharp question now stays in `Not-yet-specified`. Do not pre-slice the fog into ticket-sized pieces, because one patch may graduate into several nodes, or none, once the frontier reaches it.

### Adopting an existing track

A goal you are charting is often one you have already been walking. The effort may own a `track-<slug>.md` with a Log history. Step 4 checks for it and **adopts** it: fill Direction only if empty, append a Log entry, leave the body. A blind `printf > track.tmp && mv` would erase that history, which Obsidian Sync then propagates to every device as a deletion. Create-from-template is only for a slug with no track yet.

### Atomic writes

Creating the map (and a new track) writes a whole file. Use a sibling temp file renamed over each target — `printf %s "$content" > "$path.tmp" && mv "$path.tmp" "$path"` — so a crash never leaves a half-written map that Obsidian Sync recovers only through a manual flow. Adopting an existing track is an in-place edit, not a full write, so it skips the temp-file dance.
