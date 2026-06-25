---
name: distill
description: Compress an expository note into a dense Glossary via a standalone CLI — abstractive idea-compression, not extractive trimming. Re-expresses the note as a `## Glossary` table + a short prose tie-together, collapsing restatements to one entry each and keeping only operational tokens verbatim; a different model fidelity-grades the output against the source by round-trip entailment and surfaces any definition that did not translate. Replaces /cut. Use on /distill, "distill this", "compress this note", "make a glossary of this note", "tighten this into its ideas", "summarize as a glossary", "this note is too long/verbose", «дистиллируй», «сократи в глоссарий», «выжимка», «сделай глоссарий»; route whole-repo glossary maintenance to /glossary.
---

# distill

A standalone headless CLI that re-expresses an expository note as a dense Glossary. Unlike `cut` (extractive, retired), distill is **abstractive**: it does not keep a verbatim subset of the input — it rebuilds the note around a canonical form (a `## Glossary` table + a short prose tie-together), so restatements of one idea collapse structurally to a single entry. Word count goes down; input and output do not match line for line. Run it on a finished expository note (a vault note, a track section, a concept explainer), not on operational runbooks or code.

## How to use

When this skill fires, run the finished note through `distill-text` (the binary, on PATH) and act on its two outputs:

1. Give `distill-text` the note — a positional file path (`distill-text input.md`) or piped on stdin — under `doppler run --project claude-code --config std --` so it has `FIREWORKS_API_KEY` in env (doppler is one way to inject it). For a **vault entry named rather than pathed**, resolve the path first with `vault-query get` (it prints the absolute path, one per line): `distill-text "$(vault-query get "Target distance")"`. `--lang ru` overrides language autodetect; `--synth regenerate` switches the synthesis dial (default `render`); `--max-retries N` caps gate recovery (default 2); `--no-gate` / `--no-revise` skip stage 5 / stage 4.
2. Read the **first stdout line** — the path to a fresh temp `.md` file. Its `<result>…</result>` section holds exactly the text to write back to source (frontmatter verbatim, if any, then the distilled body: a short tie-together, the `## Glossary` table, and any operational blocks kept verbatim). A `<residue>…</residue>` section (omitted when empty) holds one `<entry term="…" reason="…">` per definition that failed the fidelity gate, with the verbatim `<source>` inside — re-read those from the source, they did not translate.
3. Read the **second stdout line** — the footer (e.g. `— distilled render · 755→381 words (-50%) · 8 entries · 1 verbatim · 0 residue · 1 retries`). A `+N%` size means the output grew — distillation expanded it (the note was too short or too list-heavy to compress); prefer the original. A non-zero residue count means open the file and recover those definitions from source.

## What it does (5 stages)

1. **Extract a combo** (`gpt-oss-120b`): {description (authored frontmatter `description:` verbatim when present — the one independent anchor; generated otherwise), thesis (the spine claim), glossary (load-bearing concepts with dense definitions, relations to other terms, and source-block pointers)}. Restatements of one concept collapse to a single entry.
2. **Grade each block** (`gpt-oss-120b`): `drop` (off-thesis or already in the glossary) / `distill` (re-express densely — the default for prose) / `retain` (only compact content that rewording would destroy — code, commands, paths, flags, a wikilink-reference list). A block carrying a `[[wikilink]]` always survives to the output (retained or distilled, never silently dropped).
3. **Synthesize** the glossary definitions via the **fidelity dial** (`--synth`): `render` (default) grounds each definition in its cited source text; `regenerate` writes from the extracted idea-graph alone. The body is assembled deterministically: tie-together prose, then the `## Glossary` table, then retained-verbatim blocks.
4. **Revise** (`gpt-oss-120b`, 4 passes): the distilled prose passes through words → sentences → paragraphs → AI patterns. Code, wikilinks, and inline code are masked and restored verbatim.
5. **Fidelity-grade** (`glm-5p2`, the **different** model): round-trip entailment — does each output definition entail its source statement and vice versa, and is the thesis recoverable? A failing definition is re-rendered from source (capped at `--max-retries`); whatever still fails is surfaced as `<residue>`, never silently shipped.

## Render a prose note from a glossary (separate, on-demand)

`distill-text render <file>` runs the inverse: it reconstructs a flowing **prose note** from an already-distilled glossary. The split is deliberate — the `## Glossary` output is the durable, gate-certified **reference**; the prose is its readable derivative, regenerable and checkable against the glossary anytime. Use it when you want the note back as paragraphs rather than a table.

- **Input**: a distilled file — this tool's own output (the `<result>…</result>` wrapper is stripped; any `<residue>` is ignored) or a saved glossary note. It reads the frontmatter, the tie-together line, the `## Glossary` table, and any retained blocks (e.g. a wikilink reference list).
- **Output**: frontmatter verbatim, then flowing prose grounded **only** in the glossary (no claim, term, or example absent from it), then the retained blocks. The `## Glossary` table itself is dropped. Same two-line stdout contract — temp `.md` path, then a footer (`— rendered prose · 221→281 words · 5 entries`).
- **Passes / flags**: reuses the four revise passes (`--no-revise` skips them) and honors `--lang`. It is **not** fidelity-gated — there is no `<residue>`; the glossary is the certified artifact, so re-ground the prose against it if a claim looks off.
- **Limit**: the rendered table is `term | definition` only, so the prose works from definitions (which often carry their relations in wording) rather than the extractor's explicit relation list — relations are softer than in the original note. The glossary remains the source of truth.

## Install / run

Requires `FIREWORKS_API_KEY` (e.g. via `doppler run --project claude-code --config std --`).

```bash
distill-text input.md                      # read from a file (auto-detect language)
distill-text < input.txt                   # read from stdin
distill-text "$(vault-query get "Entry name")"  # vault entry resolved by name → path
distill-text --lang ru input.md            # force the Russian rubric
distill-text --synth regenerate input.md   # denser dial (default: render)
distill-text --no-gate input.md            # skip the stage-5 fidelity gate
distill-text render glossary.md            # separate: prose note FROM a distilled glossary (no gate)
```

The binary is `distill-text`; it is on PATH via `.local/bin/distill-text`. It writes the XML-tagged result to a temp `.md` file; stdout is two lines — the file path, then the footer. Capture the path with `path=$(distill-text input.md | head -1)`.

## Safety model — recovery, not prevention

distill's output is **not** a verbatim subset of the source, so cut's verbatim certificate is gone. The replacement gate is **definition round-trip entailment** by an independent model (`glm-5p2`, never the writer): each output definition must be equivalent to its source statement in both directions. The gate auto-recovers a drifted definition by re-rendering it from source; a definition that still fails is named in `<residue>` with its source text, so recovery is informed re-reading, not blind trust. Equivalence (not "is this necessary") is a deliberate choice — see `35 experiments/2026-06-23-thinking-judge-correctness-gate.md` for why the necessity framing fails with this judge.

## The writing rubric

The revise step runs four sequential passes — words → sentences → paragraphs → AI patterns — embedded in `distill.ts` as the `PASS_EN` / `PASS_RU` rubric (the single source; edit them there to change behavior).

## The synthesis dial — render vs regenerate

`--synth render` (default) grounds each definition in its source block; `--synth regenerate` writes from the idea-graph alone. The dial was settled by experiment (`35 experiments/2026-06-25-distill-synth-dial-stability.md`): on clean expository fixtures render **dominates** — equal cross-run stability and restatement collapse, and _more_ compression (60% vs 54%), with no fidelity-vs-density tradeoff observed. `render` is the default. The experiment hit a stability ceiling (both dials perfectly stable), so the dial's breaking point on harder, naturally-restating notes is open.

## Limits

- **Scope**: built for expository prose (notes, concept explainers, track sections). On a short or list-heavy note it can expand rather than compress — the footer's `+N%` flags this; prefer the original.
- **Latency**: ~30–60 s (extract + grade + synth + tie + 4 revise passes + thinking-judge gate). Built for a generous budget, not an interactive hook. `--no-gate` / `--no-revise` trade fidelity/polish for speed.
- **Abstractive risk**: distill writes new text, so a definition can drift from or invent against the source. The fidelity gate catches and surfaces this, but the gate covers only glossary entries; a drift inside the tie-together prose escapes it.
- **Non-stationarity**: tuned on one model pair (gpt-oss-120b / glm-5p2) at temp 0; re-measure before trusting on a model swap.
- **Failsafe**: any parse error or timeout → passthrough (original text, footer notes the skip). A missing API key exits non-zero with a clear message rather than passing through.
