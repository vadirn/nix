# Task: Compress debate workflow while maintaining hardened quality

## Objective

Reduce the debate workflow from 18 lines while maintaining all hardened quality criteria: score >= 95, delta >= 10 over baseline, no adversarial failures.

## Baseline

Current workflow: 18 lines, scores 96.5/100, delta +34 over baseline.

## Process

Read `progress.txt` to determine which phase you are in.

### Phase A: Compress workflow

**Trigger:** progress.txt is empty, OR the last entry says "PHASE: COMPRESS" with feedback.

1. Read `home/claude/CLAUDE.md` (## Reasoning).
2. Read `home/claude/skills/debate/workflows/en.md`.
3. If progress.txt has feedback, address it.
4. Compress. Strategies:
   - Merge lines that repeat similar concepts
   - Use terser DSL syntax or a different format entirely
   - Remove instructions the model can infer (it knows what dialectical reasoning means)
   - Keep only what produces measurably different output vs baseline
   - The `[CONDITIONS]` etc. labels may be the key differentiator: keep those, cut surrounding explanation
5. Record old and new line count.
6. Append changes to progress.txt, then: `PHASE: DEBATE`

### Phase B: Run debates (with-skill AND baseline)

**Trigger:** last entry says "PHASE: DEBATE".

For each topic, produce TWO debates:
1. **With skill**: read `workflows/en.md`, follow it exactly.
2. **Baseline**: debate naturally without reading the workflow.

Save to `home/claude/evals/debate/outputs/`:
- `<topic-slug>.md` (with skill)
- `<topic-slug>-baseline.md` (baseline)

Topics:
- "Nuclear energy is the best path to decarbonization"
- "The housing crisis is primarily a supply problem"

Append to progress.txt, then: `PHASE: GRADE`

### Phase C: Grade all debates

**Trigger:** last entry says "PHASE: GRADE".

1. Read `home/claude/evals/debate/dialectical-grader.md`.
2. Grade all outputs. Save to `outputs/grades/`.
3. Compute averages for with-skill and baseline, compute delta.
4. Append scores, then: `PHASE: ADVERSARIAL`

### Phase D: Adversarial review

**Trigger:** last entry says "PHASE: ADVERSARIAL".

For each with-skill debate, find the single weakest dialectical moment. Score it 0-3 on each criterion. Save to `outputs/grades/<topic-slug>-adversarial.json`.

### Decision

After Phase D, check ALL criteria:

1. Average with-skill score >= 95
2. Delta >= 10
3. No adversarial failures (no 0-scores on weakest moments)
4. Line count decreased from previous attempt

If ALL pass AND line count <= 12: update `workflows/ru.md`, commit, append `NIGHTSHIFT_COMPLETE`.
If criteria 1-3 pass but line count > 12: append suggestions and `PHASE: COMPRESS`.
If criteria 1-3 fail: compression went too far. Append what was lost and `PHASE: COMPRESS`.

## Acceptance criteria

- [ ] Workflow <= 12 lines (ambitious) or as short as possible while passing
- [ ] Average with-skill score >= 95
- [ ] Delta >= 10 over baseline
- [ ] No adversarial failures
- [ ] `workflows/ru.md` updated
- [ ] Changes committed

## Files

- `home/claude/skills/debate/workflows/en.md` — compress in Phase A only
- `home/claude/skills/debate/workflows/ru.md` — update on completion
- `home/claude/evals/debate/dialectical-grader.md` — grading criteria
- `home/claude/evals/debate/outputs/` — debate outputs
- `home/claude/evals/debate/outputs/grades/` — grades and adversarial reviews
- `home/claude/CLAUDE.md` — dialectical method reference
