# Task: Compress debate workflow while maintaining dialectical quality

## Objective

Reduce the size of `home/claude/skills/debate/workflows/en.md` while maintaining or improving dialectical quality scores (current baseline: 89/100 average). The workflow is 49 lines with significant repetition of the dialectical method across role definitions, DialecticalMethod block, and RoundStructure.

## Baseline

Current scores (in `home/claude/evals/debate/outputs/grades/`):
- nuclear-energy: 86/100
- housing-crisis: 92/100
- Average: 89/100

Current workflow: 49 lines. Target: fewer lines, same or better scores.

## Process

Read `progress.txt` to determine which phase you are in.

### Phase A: Compress workflow

**Trigger:** progress.txt is empty, OR the last entry says "PHASE: COMPRESS" with feedback.

1. Read the current workflow at `home/claude/skills/debate/workflows/en.md`.
2. Read the dialectical method in `home/claude/CLAUDE.md` (## Reasoning).
3. If progress.txt has grading feedback, read it and address issues.
4. Compress the workflow. Strategies to try:
   - Remove redundancy (the dialectical method is stated 3 times)
   - Try different DSL syntax (terser, more structured)
   - Try a completely different format (minimal, table-based, shorthand)
   - Rely on the model's understanding of dialectics rather than spelling it out
   - Keep only what the model can't infer on its own
5. Count the lines. Record old and new line count.
6. Append to progress.txt: what you changed, old vs new line count.
7. Append: `PHASE: DEBATE`

### Phase B: Run debates

**Trigger:** the last entry in progress.txt says "PHASE: DEBATE".

1. Read the workflow at `home/claude/skills/debate/workflows/en.md`.
2. Follow it to produce a 3-round debate for each topic. Do not modify the workflow.
3. Save to `home/claude/evals/debate/outputs/<topic-slug>.md` (overwrite previous).
4. Append to progress.txt: which debates were generated.
5. Append: `PHASE: GRADE`

Topics:
- "Nuclear energy is the best path to decarbonization" → `nuclear-energy.md`
- "The housing crisis is primarily a supply problem" → `housing-crisis.md`

### Phase C: Grade debates

**Trigger:** the last entry in progress.txt says "PHASE: GRADE".

1. Read the grader at `home/claude/evals/debate/dialectical-grader.md`.
2. Grade each debate in `home/claude/evals/debate/outputs/`. Save grades to `outputs/grades/`.
3. Compute average total_score.
4. Compare to baseline (89/100) and previous iteration scores.
5. If score >= 85 AND line count decreased from previous iteration:
   - Update `workflows/ru.md` to match.
   - Commit changes.
   - If workflow is <= 25 lines: append `NIGHTSHIFT_COMPLETE`.
   - Otherwise: append suggestions for further compression and `PHASE: COMPRESS`.
6. If score < 85:
   - The compression went too far. Append: what was lost, which criteria dropped.
   - Append: `PHASE: COMPRESS` (restore some detail in next iteration).

## Acceptance criteria

- [ ] Workflow is <= 25 lines (ambitious) or as short as possible while scoring >= 85
- [ ] Average dialectical score >= 85/100 (no regression from 89 baseline)
- [ ] Both roles score >= 2 on material_conditions and contradictions in every round
- [ ] `workflows/ru.md` updated to match final version
- [ ] Changes committed

## Files

- `home/claude/skills/debate/workflows/en.md` — compress this
- `home/claude/skills/debate/workflows/ru.md` — update when scores pass
- `home/claude/evals/debate/dialectical-grader.md` — grading criteria
- `home/claude/evals/debate/outputs/` — debate outputs
- `home/claude/evals/debate/outputs/grades/` — grade JSONs
- `home/claude/CLAUDE.md` — dialectical method reference
