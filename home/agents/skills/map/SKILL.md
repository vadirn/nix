---
name: map
description: >
  Chart the way to a foggy goal too big for one session, in crux: one goal, its uncertainties as questions typed by facet, the crux marked, the fog parked as seeds. Then resolve one question per session until nothing is left to decide. Mechanizes `30 notes/SDLC/Planning.md` at map scale. Triggers: `/map`, "chart a path to", "how do I reach <goal>", "plan the way to <goal>", "roadmap for", resume phrases ("continue the map", "where were we on <goal>"). Route elsewhere: one decided unit of work → a crux work item; recording what happened → a crux note (AGENTS.md § Work state); an idea with no done-condition yet → a crux seed.
---

# Map

Chart the way to a goal whose path you cannot yet see. The map lives in crux: the goal is the destination, each open uncertainty is a question, and the fog is a seed. Crux holds the structure and refuses a wrong call. This skill holds the judgment: what to ask, in which order, with which instrument.

The engine is `Planning.md`'s: the five forces, the rung ladder, typed nodes, the fog. This skill adds two pieces for goals whose undo is expensive: risk-ordering and the Frame.

## Dispatch

```
dir = skill base directory
// ## Model below is the contract. Both modes lean on it, so read it first.

do("call `guide` once per session, before the first crux write")
project = do("call `projects`; match the repo's remote slug, else its directory name, against each ref, title, and alias.
              One hit proceeds. Zero or several: ask")
goals   = do("call `frontier(project)`; a goal the user named resolves by its alias or ref")

if the goal is fresh (no crux goal holds it):
    Read(dir/references/chart.md)
    do("follow the chart procedure: create the goal and its first frontier")
else:                                               // a named goal, or a resume phrase
    Read(dir/references/work.md)
    do("follow the work procedure: resolve the next question")
```

## Model

Every element names the force it serves. An element serving no force is ceremony, so drop it.

### The map in crux

| Map element    | Crux item or call |
| -------------- | ----------------- |
| Destination    | the goal's `result`, plus the body's opening lines |
| Frame          | a `## Frame` section in the goal body |
| Charting node  | a question, with `facet` decision, fact, or feasibility |
| Execution node | a work item, linked `spawned_by` the question that made it |
| Fog            | a seed in the goal's scratchpad |
| Blocking edge  | `link(from, to, "requires")` |
| The crux       | `crux: true` on one question per container |
| Blast-radius   | `risk`, an integer |
| A decision     | `close_question(question, claim, rationale, note_ids)` |
| Out of scope   | `drop_item(question, reason)` |
| The bookmark   | `add_note(goal, "observation", body)` |

One home per answer (Force 4). The decision lives on the question, written by `close_question` and nowhere else. The goal body never restates it, and a note narrates why now, not what.

### Nodes and instruments

Type each question by its uncertainty (Force 2). The facet dictates the instrument, and it cannot change later, so retype by recreating.

| Facet       | Resolves by         | Instrument |
| ----------- | ------------------- | ---------- |
| decision    | someone must choose | grill, or `/variants` → `/debate` → `/grade` |
| fact        | research answers it | `/research` (AFK) |
| feasibility | a probe answers it  | `/prototype`, time-boxed, discarded |
| work        | nothing open        | the work itself, in a parallel execution session |

Applying the wrong instrument burns time without closing the question. `ready` lists questions and work together, so filter to questions when charting.

### Ordering: read reversibility per node

Do not fix an order per map. Read reversibility per question (Force 5).

- **Risk-ordered**: some question is high blast-radius and expensive to undo. Mark the crux and give every question a `risk`. `frontier` then leads with the crux and ranks the rest by risk. Chart backward from the destination along the spine. Most of the goal stays fog until the spine is proven. Typical of personal and financial goals.
- **Dependency-ordered**: undo is cheap and uniform. Mark no crux and set no risk. `ready` then lists the unblocked questions by age, leaves first. Typical of software.

Judge blast-radius against the Frame and the destination, not by computing over the graph. Gate the crux choice: `/grade` it, and `/debate` the top two when under 7 or tied, before spending the crux's instrument.

### The Frame (risk-ordered goals only)

A risk-ordered goal opens with a Frame, the calibration risk-ordering needs. It is the required parameter of Force 5 when undo is expensive. No Frame, no risk-ordering.

- **Appetite**: what you will stake, a pre-committed dated walk-away floor, your time budget.
- **Capability**: skills, capital, sustainable hours and energy.

The Frame is the scoring function for blast-radius. It makes kill-conditions derived rather than ad hoc. It sends capability-exceeding paths to `drop_item`, not to fog. Seed it with `/consult` from the user's self-knowledge notes.

### Consult informs; it does not foreclose

On a decision, `/consult` surfaces prior thinking. It is a prior, not a verdict.

1. Surface the prior, labeled as prior, with its date.
2. Generate at least one independent variant regardless of what consult returned.
3. Present prior, variants, where they diverge, and your pick with the reason.
4. The user commits. Re-affirming the prior is a choice against alternatives, not a default.

Weight the divergence by stakes times staleness. Diverge hardest when the prior is strongest, because that is peak anchoring.

### Plan, don't do

Charting produces decisions, not deliverables. The map is done when nothing is left to decide: `frontier(goal)` is empty and no seed remains. The pull to start building is the signal to hand off. Every charting session ends by listing unresolved questions.

## Reference

| File                  | Purpose |
| --------------------- | ------- |
| `references/chart.md` | Bootstrap a new goal from a foggy aim: fix the destination, frame, sweep, pick the rung, create the goal and its first frontier. |
| `references/work.md`  | Advance an existing goal: reconcile the world, re-validate the Frame, resolve the next question, graduate fog. |
