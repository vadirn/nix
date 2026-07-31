# Work — advance or continue an existing map

Resolve the next frontier node, one decision per session. Continuation a week later reuses `track`'s resume flow, plus a step that reconciles the world against the map.

## Pseudocode

```
cfg = Bash(vault-query config)
map_path   = <cfg.project_path>/map-<slug>.md      // named, or the project's single map with status: open
track_path = <cfg.project_path>/track-<slug>.md    // the sibling, by shared slug

// 1. Where were we — track's resume flow (see /track read.md)
shape  = Bash(vault-query read <map_path>)                 // low-res view + frontmatter (ordering, crux, status)
snap   = Bash(vault-query read <map_path> Destination)     // = the track's Direction
latest = Bash(vault-query read <track_path> <highest Log sub-address>)   // where charting stopped
owned  = Bash(vault-query tickets --view Open --track <slug> --format tsv)
grounding = Bash(vault-query consult "<goal from Destination>" --format markdown)   // fold in on exit 0
ordering = do("read `ordering` from the map's frontmatter — do not re-derive it each session")

// 2. Reconcile the world — the step continuation adds
closed = do("which tickets closed since the last Log snapshot (from `latest`)? — ALL types, not just execution")
for t in closed:
    facts = do("harvest the facts in t's ## Resolution: a fact node's findings block, or an execution ticket's
                recorded values (fees, minimums, credentials location, row counts)")
    do("apply facts: they may UNBLOCK a decision, GRADUATE fog into a sharp question, or INVALIDATE a prior
        decision. On invalidation, append a superseding answer and strike the old IN THE NODE'S ## Resolution
        — the single home (see /vault ticket §Map nodes); never in the track or the map")

// 3. Re-validate the Frame (risk-ordered maps) — the natural checkpoint
if ordering == risk:
    if appetite or capability no longer hold (e.g. planned pace >> actual sustainable pace):
        do("FRAME-INVALIDATION: do not decide unilaterally. Raise to the human with options —
            (a) redraw the destination smaller/slower; (b) change the path; (c) kill this map, bank
            the learning to Backlog. Let the human choose. Halt until they do.")

// 4. Recompute the frontier and branch
frontier = do("open, unblocked, NON-execution nodes (kind != execution)")
if frontier is empty and blocked on undone execution work:
    do("do NOT spin. Report: charting is stalled on <execution tickets>. These are yours to do.
        Hand a precise checklist. Charting resumes once they are done. Halt.")
if frontier is empty and nothing blocks and no fog remains:
    do("charting is DONE — nothing left to decide. Set the map's status: done; hand off to execution;
        archive state into the track. Halt.")

// 5. Choose the node and GATE THE SELECTION — before spending any instrument
node = do("if ordering == risk and a crux is live → the crux; else the first frontier node in order")
if ordering == risk and node is the crux:
    do("gate the SELECTION, whatever the node's kind: /grade the crux choice; if <7 or tied, /debate the
        top two — BEFORE running the crux's instrument. Record the chosen crux in the map's crux: frontmatter")

// 6. Resolve by the node's kind (the selection gate already passed in step 5)
if node.kind == fact:
    do("/research \"<node question>\" — pass a high stakes hint if it feeds the crux;
        write the returned findings block into the node's ## Resolution")
if node.kind == feasibility:  do("time-boxed /prototype, discarded; record the verdict in ## Resolution")
if node.kind == execution:   do("execution never reaches here — the frontier excludes it (step 4). If one
                                  surfaced, it was mistyped: retype it, or route it to a parallel execution session")
if node.kind == decision:
    prior = Bash(vault-query consult "<node question>" --format markdown)
    do("CONSULT INFORMS, NOT FORECLOSES: surface prior (dated) → generate >=1 independent variant regardless
        → present prior + variant(s) + your pick with the reason → user commits.
        Scale divergence by stakes x staleness: one-line challenge if cheap/fresh, full /design if load-bearing.")

// 7. Commit
do("record the answer in the node's ## Resolution — the single home; close the ticket (status: done)")
do("append ONLY a link to the resolved node in the map's Decisions-so-far (index, never the answer text)")
do("graduate fog ONE patch at a time: any Not-yet-specified line the answer made sharp becomes a new typed
    ticket (create-then-wire, empty ## Resolution); clear that patch from the fog")
do("re-run the reversibility read over each newly-graduated node (see SKILL.md §Ordering): a high-blast node
    appearing in a dependency-ordered map flips it to risk — raise it, because the map now needs a Frame")
do("if the answer reveals a node past the destination, rule it Out-of-scope (close it, one line in Out-of-scope);
    do not resolve it on the route")

// 8. Stop — write the bookmark
do("write a track Log entry (see §Stop). The Log NARRATES the decision; it does not store it (the node's
    ## Resolution does). One decision-commit per session; cheap facts feeding this decision may batch.
    List unresolved questions.")
```

## Reference

### One decision-commit per session

The invariant binds **decisions**, not nodes. A decision's answer reshapes the next question, so commit one per session. `fact`, `feasibility`, and `execution` nodes have no such property — unlimited of them may resolve in the same session as the decision they feed. Cap the session by resolution-budget, not node count. The line is "one graduation-causing commit," never "one node."

### Harvested facts are not inert

A ticket closed a week ago — a fact node's findings or an execution ticket's recorded values — produces facts later nodes depend on. Reconciling them is what makes continuation more than picking up where you stopped. A harvested fact can **unblock** (a decision becomes takeable), **graduate** fog (a question becomes sharp), or **invalidate** (a prior decision assumed a value the fact contradicts). Invalidation is append-and-strike in the node's `## Resolution`, never a silent rewrite and never a second copy in the track or map.

### Frame-invalidation

Frame-invalidation is what the re-validation checkpoint outputs when it fails: the market bet may be fine, but the person walking the map can no longer keep the pace it assumes. Killing or redrawing a goal is the human's call, never the agent's. Surface the mismatch and two or three options; let the human decide.

### The three resume outcomes

| Frontier  | State                            | Do                                        |
| --------- | -------------------------------- | ----------------------------------------- |
| non-empty | a node is takeable               | chart it — resolve, commit, graduate fog  |
| empty     | blocked on undone execution work | report the checklist, stop — do not spin  |
| empty     | nothing blocks, no fog           | set `status: done`, hand off to execution |

### Stop — the bookmark

Every charting session ends by writing a `track` Log entry that snapshots the transient state the next entry supersedes:

- nodes resolved this session,
- the current frontier,
- what is blocked and on which execution tickets,
- the next takeable node.

Follow `/track save.md` for the Log mechanics — append the entry, bump `updated:`, never rewrite the body. Skip its `## Decisions` append for a node resolution: the node's `## Resolution` is the decision's one home, and the Log only narrates why-now. Skip the `/git commit` suggestion too — the map and track are vault content propagated by Obsidian Sync, unless changes landed in `.claude/` or the user asked.

### Editing the map without reading it whole

A mature map, like a track, is large. Get the shape first (`vault-query read <map_path>`), then unfold only the sections an edit touches (Decisions-so-far, Not-yet-specified, the frontier node). Apply localized edits at those anchors. The map is an index; keep node detail in the tickets, not restated in the map.
