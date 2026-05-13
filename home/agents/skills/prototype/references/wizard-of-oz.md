# Wizard of Oz workflow (throwaway role prototype, facilitator-only)

Use when the design question is "how should this behave from the user's side" and the intent is throwaway. Source: Kelley, J.F., "An iterative design methodology for user-friendly natural language office information applications", ACM TOIS 1984.

A human plays the system behind a real-looking interface. The user thinks they are talking to software; a wizard improvises the responses live. The output is knowledge about what users expect, not code.

## Scope: this skill produces the plan, not the data

A Claude Code agent cannot recruit users, run 30-minute sessions, read facial reactions, or play the wizard. What it can produce is the planning artifact: the user-facing interface design, the wizard's script and decision tree, the recruitment criteria, the recording protocol, and the debrief template. The human takes the plan and runs the sessions.

When the human returns with session results, they invoke `/prototype` again with a fresh design question informed by what the sessions taught. The results memo is a separate capture under a separate invocation. This file produces only the plan.

## Design the user-facing interface

The user must believe the system is real. If the user knows a human is behind the curtain, they relax their assumptions and the data degrades.

- Specify the surface the user touches: a chat window, a CLI, a form, a voice prompt. Use real production styling where cheap.
- Inputs are unconstrained. The plan should let the user say or type whatever they want.
- Outputs route to the wizard's console, not to logic.

Pick a delivery channel where wizard latency is plausible (chat tolerates a few seconds; voice does not). Add typing indicators or "processing..." affordances if the wizard needs more time than the channel allows.

## Design the wizard's side

The wizard is the cognitive load. The plan should reduce their friction:

- A script with canned responses for cases the team can predict in advance. Cuts the wizard's reaction time.
- A decision tree for choosing between scripted responses. Less freelance, more reproducible.
- A blank text field for the cases the script does not cover. These are the gold: they expose where the system needs flexibility.
- A note field for what the wizard wanted to do but could not. These are the missing capabilities.

The plan pre-briefs the wizard on persona, tone, and limits. A wizard improvising a personality is one more confounding variable.

## Plan the sessions

Three to five sessions of 15-30 minutes is enough for most questions. More sessions buy diminishing returns; fewer leave you with anecdote.

The plan specifies:

- **Recruitment criteria.** Who counts as a target user. Office-mates and friends produce sympathetic noise; the plan should rule them out.
- **Recording protocol.** What the wizard captures verbatim: user input, wizard response, hesitations, the user's reactions (confusion, satisfaction, escalation).
- **Debrief template.** One paragraph per session, written immediately after. Patterns across sessions matter more than any single moment.

## Capture

Open `references/capture-templates.md` and adapt the Decision memo to a planning artifact. The artifact starts with this header:

```
Status: planning artifact only
Design question: <verbatim from D1>
Date: <YYYY-MM-DD>
```

The body covers:

- **Method.** Channel, who will play the wizard, number of planned sessions, recruitment criteria.
- **Interface plan.** What the user touches. Inputs, outputs, latency budget.
- **Wizard plan.** Script, decision tree, blank-field protocol, persona brief.
- **Session protocol.** Recording, debrief template, what counts as a finished session.
- **Hand-off note.** "Sessions to be run by <owner>. Results return through a fresh `/prototype` invocation with a new design question."

After drafting, apply each check in `references/capture-checks.md`. Record the filled-in templates in the plan.

File the plan at `docs/spikes/<YYYY-MM-DD>-<slug>-woz-plan.md`. The `-woz-plan` suffix and the `Status: planning artifact only` header are load-bearing: they tell future readers this file is not session evidence.

## Boundary

Wizard of Oz answers role questions, not implementation questions. If the prototype confirms the role works but leaves the implementation open, the next prototype is a spike or a tracer bullet on the technique, not another wizard session.

Do not promote a Wizard of Oz to an MVP. The two are different artifacts: the wizard answers a design question with discardable evidence; an MVP is a launched product. Confusing them yields a feature that "worked in testing" because a human was behind it.

The agent does not simulate the wizard for the user. A Claude session improvising a wizard for itself produces sympathetic-noise evidence; see the "Demo as proof" gotcha in `SKILL.md`.
