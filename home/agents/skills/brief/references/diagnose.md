# diagnose — classify a complaint before reacting

Goal: take a stakeholder reaction the user relays and name which gap it is, so the user applies the remedy that closes it instead of the one that deepens it. The expensive error is one- directional: a status report aimed at a target gap confirms the stakeholder's sense that you did not hear them. So the guard is asymmetric — bias toward "target" when unsure.

## The asymmetric guard (do this first)

```
// Target-gap language: "should have", "we agreed", "this is too much", "expected X by now",
// "why isn't Y done", "that's not what I asked for", "out of scope", "over budget".
// State-gap language: "what's the status", "where are we", "is it done", "haven't heard",
// "didn't know it was blocked".

if any target-gap signal is present:
    do("""
      Do NOT pre-draft a status update. Lead with the consequence and force one choice:
      'This reads as a target gap, not a state gap. A status report here would confirm
       you're dodging the point. Is this about what you've DONE (their picture of the state),
       or about what they EXPECTED you to do (the target)?'
    """)
    // The user's one-line answer is the gate. It is not a rubber stamp because you led with
    // the consequence and a real fork, not a yes/no.
else if only state-gap signals:
    classify as state-gap (below), proceed
else:
    ask the same forced-choice question; bias toward target
```

## Classification and remedy

```
STATE GAP (impression distance)
  → their model of the state lags reality; the relational axis is starving (work happened,
    no one told them).
  → Remedy: a status update. Offer to switch to draft.md right now for this stakeholder.

TARGET GAP (target distance) → sub-classify:

  impossible  → the wants contradict themselves or reality.
              Remedy: expose the contradiction (they want A and not-A); hand back the choice
              of which constraint to relax. You are not saying "no", you are showing the fork.

  too-large   → feasible but over budget.
              Remedy: translate into a tradeoff. "All of it needs N; we have N/3. Here's what
              N/3 buys, ranked against your goal." The cut is theirs, on visible information.

  off-target  → the work doesn't match what they expected. Split:
     (a) work is right, their model is wrong → this is really an impression gap.
         Remedy: a status update in their currency (draft.md).
     (b) work is genuinely off, built to a target they never held.
         Remedy: own it, surface the divergence, recover. Recovery cost grows with how long
         it ran silent, so surface now, not at the next milestone.
```

## "Both, in order"

When it is a target gap, the user usually needs two things, and the order matters:

```
1. A status update for the work that IS done — drafted first. Proof-of-care buys the standing
   to renegotiate; opening with the renegotiation, before acknowledging real state, reads as
   defensive.
2. A renegotiation framing — drafted second. Surface the divergence from the GOAL, not the
   task list ("why before what"): an unrealistic target usually means the why was never pinned.
```

Offer both, in that order. Draft #1 via draft.md; compose #2 as a short framing that names the divergence and hands the decision back to the stakeholder. Both stay drafts — the user sends.

## Output shape

Lead with the verdict, then the remedy, then offer the draft(s):

```
Verdict: <state gap | target gap → impossible/too-large/off-target(a|b)>.
Axis starving: <artifact | relational>.
Why: <one line tied to the signal in the complaint>.
Remedy: <the matching practice above>.
Want me to draft <the update | the renegotiation framing | both, in order>?
```

