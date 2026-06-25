---
name: cut
description: Trim out-of-scope and unnecessary content from text via a standalone CLI. Cuts whole blocks, flags questionable cuts for a parent model to restore, and revises survivors for clarity. Replaces /writing-en and /writing-ru. Use on /cut, "trim this", "cut the fluff", "tighten this text", "make this shorter", "this is too wordy/verbose", "edit this down", «убери воду», «сократи», «подрежь текст».
---

# cut

A standalone headless CLI that trims over-inclusive text. It cuts whole out-of-scope blocks, flags the cuts that are judgment calls, and revises the survivors for clarity. Run it on finished text; a parent model (or human) reviews the flagged blocks and restores any from the source.

## How to use

When this skill fires, run the finished text through `cut-text` and act on its two outputs:

1. Give `cut-text` the finished text — either as a positional file path (`cut-text input.md`) or piped on stdin (`cut-text < input.txt`) — run under `doppler run --project claude-code --config std --` so it has the API key. Add `--lang ru` only to override autodetect, `--no-revise` to skip the word-level passes.
2. Read the **first stdout line** — the path to a fresh temp `.md` file. Its `<result>…</result>` section holds exactly the text to write back to source (frontmatter verbatim, if any, then the trimmed body). A `<borderline>…</borderline>` section (omitted when there are no flagged cuts) holds one `<block reason="…">` per questionable cut, with the block text verbatim inside, so you can splice it back in place.
3. Read the **second stdout line** — the footer, a one-line summary (e.g. `— cut 12 · 755→231 words · 4 borderline`). When the count is non-zero, open the file and decide, per `<borderline>` block, whether it matters for _this_ reader: each block's `reason` attribute carries the judge's classification — restore the block into the `<result>` text when its applicability condition or safety qualifier is load-bearing here. The boundary call routes to you because you hold the context the tool lacks.

Run it on text that is already complete: it is an editing pass over a finished draft, not a drafting aid.

## What it does

1. **Segment** the input into fence-aware blocks (paragraphs / code blocks).
2. **Cut** (`gpt-oss-120b`, ~3 s): the editor states the text's main point and drops every block that does not serve it. It cuts aggressively — generic follow-ups (verify-steps, cautions, alternatives, related context) go — because the judge is the safety net.
3. **Judge** (`glm-5p2`, ~15–20 s): an independent judge grades each _dropped_ block as `load` / `borderline` / `surplus`:
   - `load` → **auto-restore** (the editor wrongly dropped a load-bearing block; the judge puts it back).
   - `surplus` → **drop, unflagged** (clearly out of scope).
   - `borderline` → **drop + flag** (a judgment call — e.g. an applicability condition, a safety qualifier on a command), carrying the judge's reason out into the file.
4. **Revise** (`gpt-oss-120b`, 4 sequential passes): the survivors pass through words → sentences → paragraphs → AI patterns, each call refining the prior pass's output. Code blocks are kept verbatim; claims and structure are preserved (no invented headings or bullets).
5. **Output**: a fresh temp `.md` file (via `mktemp`), XML-tagged. A `<result>…</result>` section wraps exactly the text to write back to source (frontmatter verbatim + trimmed body); a `<borderline>…</borderline>` section holds one `<block reason="…">` per questionable cut — verbatim block text inside, the judge's classification reason in the attribute — and is omitted entirely when there are zero flagged cuts. **stdout** carries two lines: the file path, then the one-line **footer** summarizing the cut.

## Install / run

Requires `FIREWORKS_API_KEY` (e.g. via `doppler run --project claude-code --config std --`).

```bash
cut-text input.md                       # read from a file (auto-detect language)
cut-text < input.txt                    # read from stdin
cut-text --lang ru < input.txt          # force the Russian rubric
cut-text --no-revise < input.txt        # block-cut only, skip word-level revise
```

The binary is `cut-text` (not `cut` — that name belongs to coreutils); it is on PATH via `.local/bin/cut-text`. It writes the XML-tagged result to a temp `.md` file; stdout is two lines — the file path, then the footer. Capture the path with `path=$(cut-text < in | head -1)`.

## The footer — how a parent model uses it

```
— cut 12 · 755→231 words · 4 borderline
```

The footer is a one-line summary: how many blocks were cut, the word count before→after, and how many cuts were flagged borderline. The per-block reasons no longer live here — they moved into the file's `<borderline>` section, one `<block reason="…">` per flagged cut. A parent model that has the source text opens the file, reads each block's `reason` attribute (the judge's classification — e.g. the selectivity condition "when an index actually helps", or the `CONCURRENTLY` safety qualifier), and splices any block that matters for _this_ reader back into the `<result>` text before writing it to source. The boundary call is routed to the party with the context to make it.

## Safety model — recovery, not prevention

The tool does **not** guarantee a cut never drops something load-bearing. It guarantees that load-bearing drops are **auto-restored** by the judge, and that genuinely borderline drops are **flagged** for an informed recoverer (the parent model, which has the source). This is the same safety model as the cut hook: the original is always available upstream, and the `<borderline>` blocks with their `reason` attributes make recovery informed rather than blind.

The judge is the gate the experiment series tuned: it sorts boundary blocks (an actionable command, an applicability condition) into `load` (restore) or `borderline` (flag), never `surplus` (silent drop). See `41 projects/nix/track-claude-code-tooling.md` Experiments section for the run history.

## The writing rubric

The revise step runs four sequential passes, each a focused rule set embedded in `cut.ts` (`PASS_EN` / `PASS_RU`): words → sentences → paragraphs → AI patterns. Each pass refines the prior pass's output (the original `/writing-en` and `/writing-ru` skills worked the same way). The judge's readability grade uses all four joined (`RUBRIC_EN` / `RUBRIC_RU`). The full source rules are in [reference-en.md](reference-en.md) / [reference-ru.md](reference-ru.md) — edit those, then re-distill into the pass constants.

## Limits

- **Latency**: ~30–45 s per cut (editor + thinking-judge + 4 sequential revise passes). Built for a generous budget, not an interactive hook. Pass `--no-revise` to skip the revise passes and save ~12 s.
- **Single n=10 validation**: the judge prompt was tuned and validated on a fixture set; real-text generalization needs broader testing. Non-stationarity applies — re-measure before trusting on production output.
- **No revise-judge**: the revise step preserves claims by prompt guard ("do not alter claims, keep code verbatim"), not by a second judge. If a revise alters a load-bearing claim, the source is the recovery. Add a revise-judge if that risk needs gating.
- **Failsafe**: any parse error or timeout → passthrough (original text, footer notes the skip).
