# Turn the capture artifact's next step into concrete tasks

Use after the capture artifact (memo, ADR, eval set, RFC) is filed. The artifact contains a Next step section with one action; this workflow expands that action into a task list the user can execute without re-deriving it.

The goal is to leave the user with a short, ranked, dated list. Long lists rot; ranked lists drive work.

## Rules for tasks

Each task is one line in imperative form. Each task carries:

- An owner (a person, not a team).
- A deadline or a marker that it is undated and what would unblock it.
- An acceptance test: how the owner knows the task is done.

A task without all three is a wish, not a task. Either complete the missing fields or strike it from the list.

Cap the list at six items, ranked. Six is the Ivy Lee limit; past six the list stops being executable and starts being a record. If more than six tasks emerge, the top six go on the list and the rest go to a backlog file.

## Branching by intent and decision

The shape of the task list depends on what the artifact said.

### Throwaway, decision = proceed

The spike answered "yes". The next prototype or the next feature is now plausible. Tasks:

1. Strike the spike workspace from the build (`rm -rf _spikes/<slug>` or delete the branch). Owner: spike author.
2. Open the design for the production version, informed by the spike but not built on it. Owner: feature lead.
3. Write the acceptance test for the production version. Owner: feature lead. Acceptance: a test exists that fails until the feature is built.
4. If the spike surfaced unknowns the production design must address, list each as a separate task with its own owner.

### Throwaway, decision = abandon

The spike answered "no". The deliverable is the dead-end record so the question is not asked again. Tasks:

1. File the memo at `docs/spikes/<date>-<slug>.md` (already done if you are reading this from capture). Owner: spike author.
2. Add a one-line entry to `docs/spikes/INDEX.md` (create if missing): "<date>: <question> — abandoned, see <slug>.md". Owner: spike author. Acceptance: future search for the question finds the dead end.
3. If the abandon decision implies giving up on a goal, surface that to the user: "the goal is now blocked, not just the method". Owner: user.

### Throwaway, decision = revise

The spike answered "it depends" or "almost". Tasks:

1. Restate the design question with the new constraint discovered. Owner: spike author.
2. Schedule a second spike with the revised question and a new time-box. Owner: spike author. Acceptance: a new prototype invocation with a clean D1.

### Retained, ADR filed

The walking skeleton or tracer bullet is in production. The next thin slice extends it. Tasks:

1. Name the next slice in one sentence: "the next thing one user can do". Owner: feature lead. Acceptance: a one-sentence statement of the next user-facing capability.
2. Write the acceptance test for that slice. Owner: feature lead.
3. Schedule the work in normal feature process. Owner: team. Acceptance: ticket exists in the team's tracker.
4. If the ADR consequences include negative effects, list each as its own monitoring or mitigation task. Owner: whoever owns the affected system.

### Eval set, status = iterating

The prompt is not converged. Tasks:

1. Name the failure modes the current prompt cannot handle. Owner: prompt author. Acceptance: a list of two to five named failure modes.
2. For each failure mode, add cases to `evals/<slug>/cases.jsonl` that exercise it. Owner: prompt author.
3. Iterate the prompt against the expanded set. Owner: prompt author. Acceptance: pass rate stable across ten consecutive runs.
4. When converged, file the prompt as a retained artifact and move to the retained branch.

### Eval set, status = converged

Tasks:

1. Lock the prompt: copy `prompt.md` to a versioned file (`prompt-v1.md`). Owner: prompt author.
2. Wire the eval set into CI so prompt changes that fail cases block merge. Owner: infra owner. Acceptance: a CI job exists and runs on prompt changes.
3. Schedule the next prototype: the layer beyond the prompt (RAG, tools, fine-tune). Owner: feature lead.

## Output

Hand back to the user a numbered list under a heading the artifact already contains:

```markdown
## Next steps

1. <Owner>: <action>. Deadline: <date or "blocked on X">. Done when: <acceptance>.
2. ...
```

Append this list to the capture artifact in place of the existing single-line Next step, or as a sibling section if the artifact convention requires the single-line summary too.

If the list is empty (the decision was "abandon" and no follow-up matters), say so explicitly: "no next steps; the question is closed." A blank list is the dominant failure mode for abandoned spikes; the absence of a record is what causes the same question to be asked again six months later.
