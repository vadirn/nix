# Prompt-as-prototype workflow (LLM-feature, throwaway or retained)

Use when the design question is "what does the LLM do when given this prompt against these inputs". The default first step for any LLM-feature work: iterate the prompt against an eval set before adding RAG, tools, fine-tuning, or any other layer. Capture is an eval set.

## Why this comes first

Most LLM-feature failures trace to a prompt that was not stress-tested. Adding RAG to a prompt that fails on adversarial cases produces a system that fails on adversarial cases plus a vector database. Adding tools to a prompt that hallucinates produces a system that hallucinates with side effects. The prompt is the cheapest layer to iterate; iterate it to convergence before any other layer is added.

This workflow is method-orthogonal in the matrix: it applies whenever the work is LLM-feature, regardless of role / look-and-feel / implementation / integration framing.

## Define the eval cases first

Write 5-10 cases before the prompt. Cases first prevents the prompt from optimising for whatever the agent imagines the inputs to be.

Each case is one line in `evals/<slug>/cases.jsonl`:

```json
{"id": "case-001", "input": "...", "expected": "...", "notes": "...", "result": "pending"}
```

Cover three categories in the initial set:

- **Obvious wins.** Inputs the prompt should handle cleanly. If these fail, the prompt is broken.
- **Obvious failures.** Inputs the prompt should refuse, escalate, or clarify. If the prompt complies anyway, the boundary is broken.
- **Edge cases you predict.** Specific worries you have about ambiguity, adversarial input, or format drift. Documents what the team thinks the prompt must withstand.

The `expected` field is the behaviour, not the exact string. "Should refuse and cite the policy" is a valid expectation. The `notes` field carries the reason the case is in the set; without it, the eval rots as the prompt evolves.

## Draft the prompt and run

Write the prompt as `evals/<slug>/prompt.md` with a metadata block:

```
Model: <claude-opus-4-7 | claude-sonnet-4-6 | ...>
Date: <YYYY-MM-DD>
Status: iterating
```

Run the prompt against the cases. Mark each case `pass`, `fail`, or `inspect`. `inspect` covers cases where the output is unexpected but not clearly wrong, often the most informative outcomes.

A case that flickers between pass and fail across runs is a signal, not noise. Record the flicker explicitly in `notes`.

## Iterate

Expand the case set as edge cases surface. Each prompt revision is a new run against the same set. Track pass rate per revision in a short log appended to `prompt.md`.

If a class of failure cannot be fixed by prompt edits alone (the prompt cannot know the user's data, the prompt cannot enforce a side effect), the prototype's answer is "prompting is insufficient for this question." Surface that explicitly: the next prototype layer (RAG, tools, fine-tuning) is now justified.

## Convergence

The prompt converges when pass rate varies by less than 5% across ten consecutive runs over the full case set. Until that point, the prototype is not done.

If convergence cannot be reached within the time-box, the prototype's result is "the prompt does not converge for this question under the current case set." That is a valid outcome: it tells the team the question is harder than they thought, the cases are too varied, or the prompt scope is too broad.

## Capture

The capture artifact is the eval set itself: `evals/<slug>/prompt.md` plus `evals/<slug>/cases.jsonl`. Open `references/capture-templates.md` for the eval-set template and fill in the metadata fields.

After drafting, apply each check in `references/capture-checks.md`. Record the filled-in templates in the prompt.md file under a heading `## Capture checks`.

If `status` reaches `converged`, the eval set is the deliverable. Lock the prompt by copying `prompt.md` to a versioned file (`prompt-v1.md`); subsequent prompt changes that fail cases block the merge through CI (see `references/next-steps.md`).

If `status` is `abandoned`, file the eval set anyway. The cases document what was tried and why it failed; the next attempt does not start blind.

## Boundary

Prompt-as-prototype answers prompt-level questions only. If the prompt converges and the next open question is about retrieval quality, tool design, or fine-tune data composition, that is a new prototype with a new design question. Do not extend prompt-as-prototype into RAG iteration; the eval methodology is different and the open question has moved.
