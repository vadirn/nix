# Work — advance an existing goal

Resolve the next question, one decision per session. Continuation a week later starts from `track`, plus a step that reconciles the world against the map.

## Pseudocode

```
// 1. Where were we
state    = track(goal)                       // counts, open and blocked, scratchpad, decisions, note log
ordering = do("risk-ordered if any question carries `crux` or a risk; else dependency-ordered")
grounding = Bash(vault-query consult "<the goal's result>" --format markdown)   // fold in on exit 0

// 2. Reconcile the world
closed = do("which questions and work closed since the last note in the log, all kinds")
for each item in closed:
    facts = do("harvest its decision or its evidence: a fact's findings, a work item's recorded values")
    do("apply them: they may UNBLOCK a question, GRADUATE a seed into a sharp question, or INVALIDATE
        a prior decision. On invalidation, recreate the question and cite the note that overturned it;
        the old decision stays on the closed question, struck by the new one's rationale")

// 3. Re-validate the Frame (risk-ordered goals)
if ordering == risk and appetite or capability no longer hold:
    do("FRAME-INVALIDATION: do not decide unilaterally. Raise it with options: redraw the destination smaller,
        change the path, or drop the goal and bank the learning as seeds. Halt until the human chooses")

// 4. Recompute the frontier and branch
open = ready(goal), questions only
if open is empty and blocked(goal) names work: do("report the checklist of work; charting resumes after. Halt")
if open is empty and no seed remains:          do("charting is DONE. Hand off to execution. Halt")

// 5. Choose the question and GATE THE SELECTION
question = do("risk-ordered with a live crux → the crux; else the first row of `open`")
if question is the crux:
    do("/grade the crux choice; /debate the top two under 7 or tied, before spending its instrument")

// 6. Resolve by facet
if facet == fact:        do("/research \"<question>\"; add_note(question, observation, findings)")
if facet == feasibility: do("time-boxed /prototype, discarded; add_note(question, observation, verdict)")
if facet == decision:
    prior = Bash(vault-query consult "<question>" --format markdown)
    do("CONSULT INFORMS, NOT FORECLOSES: surface the prior with its date, generate one independent variant
        regardless, present prior + variants + divergence + your pick, the user commits")
    add_note(question, "observation", do("the grounds the claim will cite"))

// 7. Commit
close_question(question, claim, rationale, note_ids)            // the one home of the answer
for each action the answer implies:
    work = create_item(kind: "work", parent: goal, title)
    link(work, question, "spawned_by")
    add_done_condition(work, text); add_exclusion(work, text)
    link(work, blocker, "requires") only when something open holds it up
do("graduate fog ONE patch at a time: promote_seed(seed, 'question') for any seed the answer made sharp")
do("re-read reversibility over each graduated question: a high-blast question on a dependency-ordered goal
    flips it to risk, so raise it, because the goal now needs a Frame")
do("a question revealed past the destination: drop_item(question, reason). Do not resolve it on the route")

// 8. Stop: write the bookmark
add_note(goal, "observation", do("what resolved, the frontier now, what is blocked and on which work,
                                  the next takeable question, transient state such as unpushed commits"))
do("one decision-commit per session. List unresolved questions")
```

## Reference

### One decision-commit per session

The invariant binds decisions, not questions. A decision's answer reshapes the next question, so commit one per session. Fact and feasibility questions have no such property, and unlimited of them may resolve in the same session as the decision they feed. Cap the session by resolution budget, not by count.

### Harvested facts are not inert

A question or work item closed a week ago produces facts later questions depend on. Reconciling them is what makes continuation more than picking up where you stopped. A harvested fact can unblock, graduate, or invalidate. Invalidation recreates the question, because a closed question stays closed and its decision stays on it.

### Frame-invalidation

The re-validation checkpoint outputs this when it fails: the bet may be fine, but the person walking the map can no longer keep the pace it assumes. Killing or redrawing a goal is the human's call. Surface the mismatch and two or three options.

### The three resume outcomes

| `ready` questions | `blocked`  | Seeds | Do |
| ----------------- | ---------- | ----- | --- |
| non-empty         | any        | any   | chart it: resolve, commit, graduate fog |
| empty             | names work | any   | report the checklist, stop, do not spin |
| empty             | empty      | none  | charting is done, hand off to execution |

### The bookmark

There are no sessions in crux: a log entry is a note on the goal, capped at 1000 characters. Keep it to what the next entry supersedes: what resolved, the frontier, what blocks, the next question, and transient state. Durable answers already live on their questions, so do not repeat them.
