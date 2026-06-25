---
name: cut
description: Trim out-of-scope and unnecessary content from text via a standalone CLI. Cuts whole blocks, flags questionable cuts in a footer for a parent model to restore, and revises survivors for clarity. Replaces /writing-en and /writing-ru. Use on /cut, "trim this", "cut the fluff", "tighten this text", "make this shorter", "this is too wordy/verbose", "edit this down", «убери воду», «сократи», «подрежь текст».
---

# cut

A standalone headless CLI that trims over-inclusive text. It cuts whole out-of-scope blocks, flags the cuts that are judgment calls, and revises the survivors for clarity. Run it on finished text; a parent model (or human) reviews the footer and restores any flagged block from the source.

## How to use

When this skill fires, run the finished text through `cut-text` and act on its two outputs:

1. Pipe the text to `cut-text`, run under `doppler run --project claude-code --config std --` so it has the API key. Add `--lang ru` only to override autodetect, `--no-revise` to skip the word-level passes.
2. Read the **first stdout line** — the path to a fresh temp `.md` file holding the trimmed result. Each questionable (borderline) cut is appended verbatim below a `---` separator, so you can splice it back in place. Open the file to review, and to write back to the source if you apply the cut.
3. Read the **second stdout line** — the footer. For each block it lists as `questionable`, check the source and decide whether that block matters for _this_ reader — restore it (from the `---` section in the file) when the applicability condition or safety qualifier is load-bearing here. The footer routes the boundary call to you because you hold the context the tool lacks.

Run it on text that is already complete: it is an editing pass over a finished draft, not a drafting aid.

## What it does

1. **Segment** the input into fence-aware blocks (paragraphs / code blocks).
2. **Cut** (`gpt-oss-120b`, ~3 s): the editor states the text's main point and drops every block that does not serve it. It cuts aggressively — generic follow-ups (verify-steps, cautions, alternatives, related context) go — because the judge is the safety net.
3. **Judge** (`glm-5p2`, ~15–20 s): an independent judge grades each _dropped_ block as `load` / `borderline` / `surplus`:
   - `load` → **auto-restore** (the editor wrongly dropped a load-bearing block; the judge puts it back).
   - `surplus` → **drop, unflagged** (clearly out of scope).
   - `borderline` → **drop + flag** in the footer (a judgment call — e.g. an applicability condition, a safety qualifier on a command).
4. **Revise** (`gpt-oss-120b`, 4 sequential passes): the survivors pass through words → sentences → paragraphs → AI patterns, each call refining the prior pass's output. Code blocks are kept verbatim; claims and structure are preserved (no invented headings or bullets).
5. **Output**: the trimmed text to a fresh temp `.md` file (via `mktemp`), with each questionable cut appended verbatim below a `---` separator; **stdout** carries two lines — the file path, then the one-line **footer** naming the questionable cuts.

## Install / run

Requires `FIREWORKS_API_KEY` (e.g. via `doppler run --project claude-code --config std --`).

```bash
cut-text < input.txt                    # auto-detect language (en/ru)
cut-text --lang ru < input.txt          # force the Russian rubric
cut-text --no-revise < input.txt        # block-cut only, skip word-level revise
```

The binary is `cut-text` (not `cut` — that name belongs to coreutils); it is on PATH via `.local/bin/cut-text`. It writes the trimmed text to a temp `.md` file; stdout is two lines — the file path, then the footer. Capture the path with `path=$(cut-text < in | head -1)`.

## The footer — how a parent model uses it

```
— cut 7 block(s) · 127→13 words · 1 questionable: [It helps most when each user owns a small fract…] · restore from source if needed
```

The `questionable` list names each borderline cut by its first line. A parent model that has the source text reads the footer and restores any flagged block that matters for _this_ reader — e.g. the selectivity condition ("when an index actually helps") if the user's data distribution is unknown, or the `CONCURRENTLY` safety qualifier if the table is under write load. The boundary call is routed to the party with the context to make it.

## Safety model — recovery, not prevention

The tool does **not** guarantee a cut never drops something load-bearing. It guarantees that load-bearing drops are **auto-restored** by the judge, and that genuinely borderline drops are **flagged** for an informed recoverer (the parent model, which has the source). This is the same safety model as the cut hook: the original is always available upstream, and the footer makes recovery informed rather than blind.

The judge is the gate the experiment series tuned: it sorts boundary blocks (an actionable command, an applicability condition) into `load` (restore) or `borderline` (flag), never `surplus` (silent drop). See `41 projects/nix/track-claude-code-tooling.md` Experiments section for the run history.

## The writing rubric

The revise step runs four sequential passes, each a focused rule set embedded in `cut.ts` (`PASS_EN` / `PASS_RU`): words → sentences → paragraphs → AI patterns. Each pass refines the prior pass's output (the original `/writing-en` and `/writing-ru` skills worked the same way). The judge's readability grade uses all four joined (`RUBRIC_EN` / `RUBRIC_RU`). The full source rules are in [reference-en.md](reference-en.md) / [reference-ru.md](reference-ru.md) — edit those, then re-distill into the pass constants.

## Limits

- **Latency**: ~30–45 s per cut (editor + thinking-judge + 4 sequential revise passes). Built for a generous budget, not an interactive hook. Pass `--no-revise` to skip the revise passes and save ~12 s.
- **Single n=10 validation**: the judge prompt was tuned and validated on a fixture set; real-text generalization needs broader testing. Non-stationarity applies — re-measure before trusting on production output.
- **No revise-judge**: the revise step preserves claims by prompt guard ("do not alter claims, keep code verbatim"), not by a second judge. If a revise alters a load-bearing claim, the source is the recovery. Add a revise-judge if that risk needs gating.
- **Failsafe**: any parse error or timeout → passthrough (original text, footer notes the skip).
