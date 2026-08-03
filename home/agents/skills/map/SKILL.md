---
name: map
description: >
  Chart the way to a foggy goal too big for one session. Build a `map-<slug>.md` roadmap of typed decision nodes in a vault project, then resolve one per session until the way is clear. Sibling of `track` (the walked trail; shared slug). Mechanizes `30 notes/SDLC/Planning.md` at map scale. Triggers: `/map`, "chart a path to", "how do I reach <goal>", "plan the way to <goal>", "roadmap for", resume phrases ("continue the map", "where were we on <goal>"). Route elsewhere: one decided unit of work → `/vault ticket`; recording what happened → `/track`; an idea with no done-condition yet → a Scratchpad seed.
---

# Map

Chart the way to a goal whose path you cannot yet see. The map is the planned route. Its paired `track` is the trail actually walked. One map per destination; many maps per project. A project need not be code.

This skill **extends `Planning.md` to map scale**. Its engine is the note's — the five forces, the rung ladder, typed nodes, the fog schema. It adds two pieces for goals whose undo is expensive: risk-ordering and the Frame — extensions to record back into `Planning.md` as preferences. Named systems (Mikado, Wayfinder, rolling-wave) are configurations of the same forces. A map is the **rung-4 artifact** of that ladder, reached only when a goal is fogged and larger than one session.

## Dispatch

```
dir = skill base directory
// The ## Model section below is the contract. Both modes lean on it — read it first.

project = Bash(vault-query config)                  // or --project <name>; a project need not be a repo
maps    = Bash(discover map-*.md in the project)    // see ## Model §Discovery

if the goal is fresh (no map exists for it):
    Read(dir/references/chart.md)
    do("follow chart procedure — bootstrap a new map")
else:                                               // a named map, or a resume/continue phrase
    Read(dir/references/work.md)
    do("follow work procedure — advance or continue an existing map")
```

## Model

The contract shared by both modes. Every element names the force it serves. An element serving no force is ceremony — drop it.

### Artifact and pairing

- A map is `map-<slug>.md` in `<project>/`. It pairs **1:1** with `track-<slug>.md` by the **shared slug** — the primary key. No cross-reference field. Derive the sibling path by swapping the prefix.
- Map = the planned route. Track = the walked trail. The map's **Destination** is the track's **Direction**. (Force 4, durable referent.)
- The map is an **index**, not a store, instantiated from `templates/Map.md`. Frontmatter: `type: map`, `slug`, `status` (`open`/`done`/`abandoned`/`superseded`), `ordering` (`risk`/`dependency`), `crux` (wikilink to the crux node, risk-ordered only), `project`, `created`/`updated`. Sections: `Destination`, `Frame` (risk-ordered only), `Decisions-so-far`, `Not-yet-specified` (the fog), `Out-of-scope`, `Backlog`.
- **One home per answer (Force 4).** A node's answer lives in its ticket's `## Resolution`, nowhere else. `Decisions-so-far` holds only a **link** to the resolved node, never the answer text. The paired track's Log narrates it. Three copies of one decision is the failure this rule prevents.

### Nodes and instruments

A node is a ticket in the project's `Tickets.base`, carrying `kind:` (`decision`/`fact`/`feasibility`; a plain execution ticket is `kind: execution`), `track: track-<slug>`, and `requires:` blocking edges (see `/vault ticket` §Map nodes). The **charting frontier** is the open, unblocked, **non-execution** nodes (`kind != execution`). Type each node by its uncertainty (Force 2). The type dictates the instrument:

| Node type   | Resolves by               | Instrument |
| ----------- | ------------------------- | ---------- |
| decision    | someone must choose       | grill, or `/design` → `/debate` → `/grade` |
| fact        | research answers it       | `/research` (AFK) |
| feasibility | a probe answers it        | `/prototype`, time-boxed, discarded |
| execution   | nothing open — just do it | the work itself (this is the execution node) |

`decision` / `fact` / `feasibility` are charting nodes. The frontier is built from these. `execution` is the "milestone", so it never enters the charting frontier. It is handed to a parallel execution session, not resolved here. Applying the wrong instrument (researching a decision, deliberating a fact) burns time without closing the node.

### Ordering: read reversibility per node

Do not fix an order per map. Read reversibility per **node** (Force 5). The map is **risk-ordered** if any node is high blast-radius and expensive to undo. Otherwise it is **dependency-ordered**.

- **Risk-ordered** — resolve the highest `blast-radius × irreversibility` node — the **crux** — first, globally. Then chart backward from the destination along the spine of next-most-key nodes. Most of the goal stays fog until the spine is proven. Typical of personal and financial goals.
- **Dependency-ordered** — resolve leaves-first, the `Planning.md` default. Typical of software, where undo is cheap and uniform.

Judge blast-radius against the **Frame and destination**, not by computing over the graph (most of the graph is still fog). So gate the crux **choice**: `/grade` it. If under 7 or tied, `/debate` the top two — before spending the crux's expensive instrument.

### The Frame (risk-ordered maps only)

A risk-ordered map opens with a Frame — the calibration risk-ordering needs. It is not a sixth force. It is the **required parameter of Force 5** when undo is expensive. No Frame → no risk-ordering.

- **Appetite** — what you will stake, a **pre-committed dated walk-away floor**, your time budget.
- **Capability** — skills, capital, sustainable hours and energy.

The Frame is the scoring function for blast-radius. It makes kill-conditions derived, not ad-hoc ("kill if <5/200 convert" is an appetite statement). It sends capability-exceeding paths to `Out-of-scope`, not fog. Seed it with `/consult` from the user's self-knowledge notes. The first crux tests the Frame — real appetite and capability — as much as the market.

### Consult informs; it does not foreclose

On a decision node, `/consult` surfaces prior thinking. It is a prior, not a verdict.

1. Surface the prior, labeled as prior, with its date.
2. Generate at least one independent variant **regardless** of what consult returned.
3. Present prior + variant(s) + where they diverge + your pick, with the reason.
4. The user commits. Re-affirming the prior is a choice against alternatives, not a default.

Scale the divergence: a one-line challenge on a cheap, fresh node; a full `/design` on a key one. Weight by **stakes × staleness**, where staleness is the prior's date against a threshold — objective, not the agent's introspection. Diverge hardest when the prior is strongest. That is peak anchoring.

### Storage and concurrency

- The vault's tracker **is** `Tickets.base`. The map file is the index. A project with no base runs `vault-query tickets-init`. There is no parallel-`nodes:`-YAML fallback, which `Planning.md` forbids.
- **One charting session per map at a time.** Charting mutates shared index state (fog, Decisions-so-far) that Obsidian Sync cannot merge. It is last-writer-wins. Serialize it.
- **Execution runs in parallel.** Many `execution` tickets may be worked at once. They change no plan structure.
- **Rename** is one atomic operation: move the `map`/`track` pair together and rewrite `track:` on the child tickets. A shared-slug link breaks silently otherwise.

### Plan, don't do

Charting produces **decisions**, not deliverables. The map is done when nothing is left to decide. Remaining nodes are all execution. The pull to start building is the signal to hand off. Every charting session ends by listing unresolved questions. A map claiming none is claiming more visibility than the fog allows.

### Discovery

Resolve the project with `vault-query config` (or `--project <name>`). Find its maps by globbing `map-*.md` in the project directory. Frontmatter `status: open` marks a live one. A map's paired track is `track-<slug>.md` beside it. (A `vault-query maps` view mirroring `tracks` is the clean version to add later.)

## Reference

| File                  | Purpose |
| --------------------- | ------- |
| `references/chart.md` | Bootstrap a new map from a foggy goal: fix destination, frame, classify, pick the rung, create the map and its first frontier. |
| `references/work.md`  | Advance or continue an existing map: reconcile the world, re-validate the Frame, resolve the next frontier node, graduate fog. |
