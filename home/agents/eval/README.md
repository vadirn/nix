# AGENTS.md A/B harness

Every candidate edit to `home/agents/AGENTS.md` is tested against the current file before it ships. This directory holds the instrument. Model answers and scored results live outside this repo, since this repo is public and the answers are private.

## One command

```bash
bash home/agents/eval/eval.sh
```

Re-scores every stored corpus and prints the t-test report. It touches no API, so it is free and reproducible from the answers already on disk.

## Where the data lives

`config.sh` resolves `AGENTS_EVAL_DATA`, defaulting to `~/Documents/agent-calibration`. It holds `corpus/<model>/` (one answer per cell, named `<arm>__<case>__<rep>.txt`) and `results/<model>.tsv` (per-cell measurements). Set `AGENTS_EVAL_DATA` to point a run at a different corpus.

It sits outside the vault deliberately: 280 files of raw model prose are data for an instrument, and the note tooling has no business walking them.

The answers are kept because they cost quota to produce, and a new detector can be run against them without paying again.

## Design

One factor differs between arms: the text of the condition file appended as the system prompt. Model, cases, temperature, and reps stay fixed, so a difference in scores is attributable to that text alone (method of difference).

- `cases.jsonl` — six prompts. Four probe sensitivity, `merge-vs-rebase` is the specificity control (contrast is legitimate when correcting a false belief), `monorepo-grade` guards the confidence-grade instruction against collateral loss.
- `conditions/*.md` — one arm each. `a-current` is `AGENTS.md` §Reasoning plus §Uncertainty, verbatim from `main`; it is the baseline every arm must beat.
- `score.sh` — mechanical, no judge. Every metric is a regex or a word count, so the numbers rederive from the answers alone. `calib/` holds the labelled positives and negatives the detector was calibrated on: 8/8 caught, no false positives.
- `stats.sh` — Welch t-test of each arm against the baseline.

## Reading the numbers

Read the verdict column, never the means. Arm means have misled this project repeatedly: a GLM result at `t=1.83` with n=30 collapsed to `t=1.08` at n=71.

- `|t| >= 2` — the arm differs from the baseline.
- `|t| < 2` and n reaches `n80` — the arm is genuinely not distinguishable.
- `|t| < 2` and n falls short of `n80` — unresolved. More reps can still move it.

`n80` is the per-arm n giving 80% power at the observed effect size. It is what licenses adopting a change, and it is why an arm that merely looks fine is not yet a result.

## Standing result (2026-07-23): de-rhetoric wins

`g-derhetoric` is the first arm to beat the deployed file, and it is now applied to `AGENTS.md`.

| metric                      | `a-current` | `g-derhetoric` |     t | verdict |
| --------------------------- | ----------: | -------------: | ----: | ------- |
| contrast /1k                |        6.07 |           4.78 | -2.23 | better  |
| em-dashes per answer        |        3.57 |           2.97 |       |         |
| answer words                |         305 |            279 |       |         |
| grade, recommendation cases |       33/33 |          33/33 |       | intact  |

n=77 per arm on `cases-agentic.jsonl`, blocked by case. It changes four antithesis constructions in the file's own prose and adds no prohibition, keeping every doctrine claim — the diff is checkable and every element survives.

Two lessons sit behind that number. The first is that the file was demonstrating what it asked against: `charges for problems solved rather than lines written`, `Lazy about the answer, thorough about the reasoning`, `pragmatic and silent … is slop; pragmatic and explicit … is ordinary engineering`. Five earlier arms all _added_ text describing the construction and all lost; this one only removes the demonstration.

The second is that the unblocked test read `t=-1.76` and called it unresolved. Cases differ enormously in base rate — `improve-rule` at 11.7 per 1k against `merge-vs-rebase` at 0.6 — and carrying that spread as error variance was hiding a real effect. Blocking is not optional here; the arms run identical cases by construction, so the unpaired analysis was simply the wrong one.

The grade guard needs reading per case. Aggregate emission falls from 92% to 74%, but all three cases that request a recommendation score 33/33 in both arms. The drop is `a-current` grading pure explanation, where the doctrine says grade recommendations — so the arm follows the instruction more closely, not less.

### Pushing past `g` — the floor (2026-07-23)

Six distinct levers were run against `g` at n=77, blocked by case, to see whether any metric moves further. None does. `g` is the floor for in-file editing.

| attempt | arm | lever | vs `g` |
| ------- | ------------- | ---------------------------------- | -------------------------------------- |
| 1 | `h-destaccato` | inline labels → `###` headings | staccato **worse** (+0.94, t=+3.26) |
| 2 | `i-nodash` | drop the definition em-dashes | em-dash flat (+0.20, t=0.30) |
| 3 | `j-flowlabels` | labels → flowing sentences | staccato worse (+0.38, t=+2.38) |
| 4 | `k-lean` | tighten wording, every claim kept | staccato worse (+0.52), contrast +0.36 |
| 5 | `l-positive` | add `Write in flowing prose.` | contrast worse (+0.75, t=+1.72) |
| 6 | `m-reorder` | style directive first (primacy) | both worse |

Three findings hold the floor in place. Contrast moves only by removing demonstrations, and `g` already removed them all — its prose scans clean, so nothing is left to cut, and adding text (`l`) offsets the gain. Staccato rises under every edit tried: `a-current` at 0.25 is the true floor, `g` already cost +0.18 reaching it, and no edit recovers that without losing the contrast win — restructuring the opening labels (`h`, `j`) makes it markedly worse, so headings and fragments in the file prime clipped output. Em-dash sits at ~11.3 per 1k in every arm including `a-current`; the "avoid em-dash asides" instruction all arms carry sets that floor, and no file-prose edit reaches below it.

Two candidates promised at low n and collapsed at power, each the same lesson the project keeps relearning: `l-positive` read contrast 4.05 at n=14 (−0.73) and reversed to 5.53 at n=77; `k-lean` read staccato 0.00 at n=14 and rose to 0.95. Direction at n≤14 is noise here.

The lever that remains is not another edit. Every in-file intervention is bounded by the same ceiling, so the standard that cannot be lowered at generation time needs a home outside the always-loaded file — a post-generation pass or review-time correction, which is what the project's Needed list already calls for and what arXiv:2406.01297 endorses (self-correction works with reliable external feedback). That is a different lever class, not an arm.

## Earlier result (2026-07-22)

On Claude, n=18 per arm, metric `contrast_per_1k`:

| arm               | mean |    t | verdict                |
| ----------------- | ---: | ---: | ---------------------- |
| `a-current`       | 1.13 |   -- | baseline               |
| `e-lean`          | 2.58 | 1.81 | unresolved, needs n≈44 |
| `b-proposed`      | 3.74 | 2.78 | worse                  |
| `d-examples`      | 4.07 | 2.84 | worse                  |
| `c-slot`          | 2.96 | 2.89 | worse                  |
| `f-lean-examples` | 4.29 | 3.18 | worse                  |

Four of five rewrites are measurably worse than the file they were meant to improve, and the two arms carrying paired examples came last. Every losing arm adds text describing the construction it wants suppressed; `a-current` wins by naming only the positive form (`affirmative form`, two words). This is the ironic-rebound prediction of arXiv:2511.12381, and it inverts the instinct to fix a prose habit by writing a rule against it.

`e-lean` is the one open question. It only removes text, and at n=18 it sits below the bar in both directions. Resolving it decides whether the 30% cut is free.

All six GLM arms are within noise, which is why a cross-model arm cannot stand in for a Claude arm.

## The transcript metric

```bash
python3 home/agents/eval/transcripts.py --by week
python3 home/agents/eval/transcripts.py --split 2026-07-22
```

`transcripts.py` scores the same detector over every assistant turn in `~/.claude/projects/*/*.jsonl`. It observes one condition — whatever is deployed — across time, so an edit registers as a break in a series rather than as a difference between arms. Subagent sidechains are excluded, since that output never reaches the user; turns under 80 words are excluded by default, since most are one-line narration. Rates are summed counts over summed words per bucket, never a mean of per-turn rates.

It changes how the arm table should be read. Over 121k words of real prose the rate is **5.44 per 1k**, against the Claude baseline arm's **1.13**:

| source                 | ctr/1k |
| ---------------------- | -----: |
| real transcripts       |   5.44 |
| GLM arm `a-current`    |   4.71 |
| Claude arm `a-current` |   1.13 |

The six prompts put Claude in a regime where the construction is five times rarer than in the work it actually does — they ask for neutral exposition, while real turns compare designs, justify decisions, and correct the user, which is where the construction lives. Every Claude arm so far was therefore measured near the floor, which is the plainest available explanation for why arms needed n≈44 to separate at all. The GLM baseline lands near the real rate, so the cross-model arms were sampling the right regime and the Claude arms were not.

Power comes free here. About 37k words per side — one active week — resolves an 18% change at `|z| >= 2`, against 52 billed calls to resolve one synthetic arm. Read the `n80`-equivalent line the split test prints before believing any move.

### Staccato

The clipped register: a sentence after the first running six words or fewer with no finite auxiliary or copula. `Not yet built.` and `Auto-commits enabled.` both count; the boundary is the rhythm, not the negation. Sentences spanning a newline are markdown structure and are excluded, or `Three coordinated edits:` followed by a list marker would score as a fragment.

It runs at **1.22 per 1k** over 122k words, against 5.44 for `contrast`. Because it is the rarer event it needs more exposure to move: roughly six active weeks per side to resolve a change of a tenth.

An earlier version of this file reported 0.02 per 1k and called the form absent. That was wrong three times over — the sentence splitter broke on every `AGENTS.md`-shaped filename, the pattern matched only a bare `not` opener, and the conclusion drawn was that the detector needed no further work. The true rate is 61 times higher.

## Calibration

```bash
python3 home/agents/eval/calibrate.py
```

`calib/` holds labelled cases for both detectors, and `calibrate.py` asserts every positive scores and every negative scores zero. This is the guard that was missing: the staccato detector had data but no runner, so nothing failed when the splitter shredded filenames.

It works. Adding the structural cases immediately exposed a fragment guard that checked the wrong sentence, and fixing it moved the transcript rate from 1.64 to 1.22 — a quarter of the prior hits were markdown list markers rather than prose.

The negatives are the load-bearing half, one per guard: over the six-word line, short but carrying an auxiliary, negated contractions (`isn't`, `won't`), markdown structure spanning a newline, a turn-opening fragment with nothing to clip against, and filenames that must survive splitting. Add a case here before changing a pattern.

## Running an arm

Claude, billed against the session quota:

```bash
CONDS="a-current e-lean" bash home/agents/eval/run-claude.sh 8
```

Isolation comes from `--safe-mode`, which suppresses `CLAUDE.md` discovery, skills, plugins, and hooks while leaving auth intact — verified by a probe that answers "Yes" without the flag and "no" with it. Each arm therefore sees only its own condition file. Runs are resumable: a completed cell is never rebilled.

GLM on Fireworks, for cheap cross-model checks:

```bash
doppler run --no-fallback --project claude-code --config std -- \
  bash home/agents/eval/run-eval.sh 5
```

Then `bash eval.sh` to rescore.
