# AGENTS.md A/B harness

Every candidate edit to `home/agents/AGENTS.md` is tested against the current file before it ships. This directory holds the instrument. Model answers and scored results live outside this repo, since this repo is public and the answers are private.

## One command

```bash
bash home/agents/eval/eval.sh
```

Re-scores every stored corpus and prints the t-test report. It touches no API, so it is free and reproducible from the answers already on disk.

## Where the data lives

`config.sh` resolves `AGENTS_EVAL_DATA`, defaulting to the vault sidecar `35 experiments/2026-07-22-agentsmd-archetype-arms.files/`. It holds `corpus/<model>/` (one answer per cell, named `<arm>__<case>__<rep>.txt`) and `results/<model>.tsv` (per-cell measurements). Set `AGENTS_EVAL_DATA` to point a run at a different corpus.

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

## Standing result (2026-07-22)

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

Staccato (`A. Not B. Not C.`) is measured and is absent: 3 hits in 121k words, 0.02 per 1k. Separating it from a rate that shape would need 1.9M words per side. The detector exists and needs no further work.

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
