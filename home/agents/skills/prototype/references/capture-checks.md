# Capture checks

Run these checks before filing the capture artifact (memo, ADR, eval set, RFC). They apply to every workflow in this skill -- spike, tracer bullet, walking skeleton, Wizard of Oz, prompt-as-prototype. Each check is a one-line template the agent fills in; keep the templates short so they cannot drift from one workflow to another.

## Confidence

Confidence: <1-10>. Biggest risk that could lower this grade: <one sentence>.

A grade below 6 is a signal that the question may not be answered. A partial answer under time pressure is a valid outcome; a low-confidence grade reported as a clean answer is not. Choose one: extend the time-box once with written justification, rephrase the question and run again, or proceed and document the partial result explicitly.

## Falsification

What would falsify this conclusion: <one sentence>. Branches the prototype did not exercise: <comma-separated list, or "none">.

If acting on the answer is expensive, expand each unexercised branch into a follow-up task via `references/next-steps.md`.

## Prose polish

Cut filler, nominalisations, passive voice. The artifact is the document future readers will use; it must hold up to scrutiny without the conversation that produced it.

## Reasoning chain

If the decision is contested, walk the chain: thesis, premises, conclusion. Each premise has real grounding -- fact, measurement, or cited source. Flag any unsupported step.

## Layering sibling skills

This skill is standalone and does not dispatch to sibling skills. On hosts where `/grade`, `/distill`, or `/probe` are installed, run them against the filed artifact yourself for sharper checks. The prototype skill produces an artifact that those skills can audit; it does not invoke them.
