# Concepts (operational recap)

This is the working vocabulary the two procedures rely on. It compresses two vault notes;
read the originals for the full argument (resolve the path with `vault-query get "Impression distance"`
or `vault-query get "Target distance"`, then Read it). Do not duplicate their prose into output — point to them.

## Two distances

**Impression distance** — the gap between the actual state of the work and a stakeholder's
model of that state. Indexed to the stakeholder, not the work: the same work gives different
distances to different people. Closed by **reporting state**. This is what `draft` addresses.

**Target distance** — the gap between what the stakeholder thinks _should_ be done and what
is feasible or agreed. Closed by **renegotiating the target**, never by a status update.
Splits three ways:

- **impossible** — the wants contradict themselves or reality. Expose the contradiction (A and not-A both wanted); hand the choice of which to relax back to them.
- **too-large** — feasible but over budget. Translate into a tradeoff: "all of it needs N, we have N/3, here is what N/3 buys ranked against your goal — you cut."
- **off-target** — the work does not match what they expected. Sub-splits: **(a)** the work is right and their model is wrong → this is really an impression gap, draft a status update; **(b)** the work is genuinely off, built to a target they never held → own it, surface the divergence, recover. Recovery cost grows with how long it ran silent.

The error the skill exists to prevent: answering a target objection ("this is too much")
with a state report ("here is what shipped"), which confirms you did not hear the objection.

## Two axes

- **Artifact axis** — proof-of-work. Closed by doing the job and by artifacts the stakeholder can inspect (merged PRs, shipped features). Necessary, not sufficient.
- **Relational axis** — proof-of-care. The stakeholder's sense that someone is attending to them, keeping them in the loop without being chased. Produced only by the human act of communicating. "I keep checking PRs myself" is the relational axis starving, not the artifact axis failing.

This is why the skill never sends: the relational axis is yours to produce. The draft carries
the content; the act of sending carries the care.

## Inspection-closeable vs communication-only

A status update has two kinds of content:

- **Inspection-closeable** — what an artifact already carries (what merged, what shipped). The stakeholder _could_ close this by looking. One terse line in the draft; do not pad it.
- **Communication-only** — the part **no artifact carries**: what is blocked and why, what is at risk, why something is slower, the revised estimate, what is next, the counterfactual value of work that is not a feature. This is the substance of the update, and — crucially — it is _not in your git log_. The machine cannot extract it; it can only infer a guess or get it from you. That constraint drives the provenance discipline in `draft.md`.

## Currency translation

Stakeholders count in different units. Some count shipped features; infra and exploration
read as "nothing happened" to them. Close the distance in _their_ currency: render infra work
as its counterfactual ("without this, the next three features each cost ~2×"), not in
infra-currency ("refactored the layout system"). A counterfactual is a claim about the future,
so it is the easiest field to fabricate — mark it for verification, never assert it as fact.
