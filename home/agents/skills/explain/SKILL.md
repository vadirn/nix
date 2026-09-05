---
name: explain
description: >
  Explain the current topic clearly to an intelligent adult, choosing concise prose and the smallest
  useful visual or code sketch. Trigger on "/explain [topic]", "explain this", "break this down for me",
  "show me how this works", or requests to understand a concept, flow, structure, or change in the
  current discussion. Use conversation context when no topic is supplied. Requests to implement or
  review something stay with their implementation or review workflow.
---

# Explain

Help the reader understand the current topic quickly. State the key idea plainly, then use the
smallest representation that makes it clear.

## Calibrate the explanation

- Treat the reader as an intelligent adult. Infer their knowledge from the conversation; explain
  unfamiliar parts and build on what they already know.
- When an assumption about prior knowledge materially changes the explanation, state it briefly and
  continue. Ask only when the topic itself cannot be inferred.
- Open with the answer or central distinction. Ground explanations of actual code or behavior in the
  relevant source, and distinguish illustrative sketches from verified implementation.
- Prefer literal, specific words. Define unfamiliar jargon briefly at its first use, retaining the
  real term so the reader can recognize and search it later. Use an analogy only when it clarifies
  something literal wording cannot; keep it short and adult.
- Give the main path first, usually readable in under a minute. Let the question determine the number
  of steps and the depth. Follow-ups advance from the reader's current understanding.

## Choose the representation

Choose by what the reader needs to see. Prose alone is sufficient when it resolves the question.

| What needs clarifying                              | Smallest useful form |
| -------------------------------------------------- | -------------------- |
| A meaning or distinction                           | Short prose with one concrete example |
| A process                                          | Ordered steps |
| Logic or an algorithm                              | Pseudocode |
| Runtime calls and ownership                        | Call tree |
| UI composition, state, or module boundaries        | Component tree with relevant hooks, props, or paths |
| File responsibilities                              | Shallow annotated file tree |
| Interactions, control flow, or data flow           | Mermaid sequence or flow diagram |
| What changes in an existing shape                  | Diff of code, a tree, or pseudocode |
| A mostly new or copyable target shape              | The complete relevant block |
| A visual layout or a dense relationship            | One focused HTML/SVG view |
| A sequence best understood through concrete scenes | A short comic strip |
| How changing an input affects an outcome           | A small interactive view when exploration helps |

For example, a caching rule can fit in this sketch:

```text
on(save)
  if content is unchanged
    return cached result
  write new content
  return fresh result
```

Keep only the calls, files, states, and boundaries needed for the question. Preserve enough context
to show ownership and order. Use several views only when each answers a distinct part of the question.
Place each view beside the short explanation it supports.

## Make visuals earn their place

- Use the host's supported rendering. Render Mermaid directly when supported; otherwise deliver a
  rendered artifact. Trees, pseudocode, and diffs are intentionally readable text.
- Build HTML only when a simpler view loses something essential. Use real labels and data when
  available, readable type, restrained color, and a layout that works on desktop and mobile. Match
  the product's styling when explaining an existing product.
- For a comic strip, give each scene one action and a plain subject-verb-object title. The titles
  should tell the story on their own. Reuse recognizable characters and add captions only for new
  facts.
- Inspect generated artifacts for readable labels, clipping, and correct relationships. Open or
  attach the result through the available host tools, with a usable file link.

## Finish when the point is clear

Use connected prose and concrete examples. Keep preambles, repeated summaries, decorative graphics,
and forced closing invitations out of the answer. End on the fact that resolves the question. Carry
the same calibration into follow-ups, adjusting depth as the reader's understanding grows.
