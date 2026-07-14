---
name: textkit
description: A text-processing engine shipping three headless CLIs over one shared writing/extraction core. distill-text extracts an expository note's typed knowledge graph — concepts, judgements, inferences, procedures, payload — and projects it as a certified, span-anchored canonical note (abstractive idea-compression, not extractive trimming), with a residue backstop from a different model. polish-text copy-edits a markdown note (four writing passes, spell/grammar, typography, name lint) without compressing or gating it. card-stage reads an already-distilled note and stages extraction candidates as review files under a card-staging inbox. Replaces /cut. Use on /distill, /textkit, "distill this", "compress this note", "make a glossary of this note", "tighten this into its ideas", "summarize as a glossary", "compress this guide/procedure into steps", "this note is too long/verbose", "polish this note", "copy-edit this", "clean up this prose", "stage cards from this note", "extract cards", «дистиллируй», «сократи в глоссарий», «выжимка», «сделай глоссарий», «сократи гайд в шаги», «отредактируй текст»; route whole-repo glossary maintenance to /glossary.
---

# textkit

An umbrella over three standalone headless CLIs that share one text-processing core (`src/core/`: the Fireworks transport, frontmatter/text utilities, and the writing passes). Each CLI is a separate binary on PATH via `.local/bin/`; each fills `FIREWORKS_API_KEY` from the macOS Keychain (service `fireworks-api`) via its `bin/` wrapper, or takes it from env (`doppler run --project claude-code --config std --`).

| CLI | What it does | Input | Output |
| --- | --- | --- | --- |
| `distill-text` | Re-express a note as a typed, span-anchored knowledge graph; abstractive compression | an expository/how-to note | a canonical note projected in seven sections, applied back to source after review |
| `polish-text` | Copy-edit prose (four writing passes + spell/grammar + typography + name lint); no compression, no gate | any markdown note | the polished note, exact bytes on stdout |
| `card-stage` | Stage extraction candidates from an already-distilled note as review packets | a distilled note (a file path) | one staging file per candidate under a card-staging inbox |

`distill-text` is the primary tool and carries the bulk of this doc; `polish-text` and `card-stage` are documented after it.

---

# distill-text

A standalone headless CLI that re-expresses an expository note as a typed, span-anchored knowledge graph. Unlike `cut` (extractive, retired), distill is **abstractive**: it does not keep a verbatim subset of the input — it rebuilds the note around a canonical form. The graph has five knowledge-element types — **concept**, **judgment**, **inference**, **procedure**, **payload** — and markdown is one projection of it: a `# title`, an unanchored `## Abstract` orientation, then the type-as-section blocks (`## Concepts` / `## Judgements` / `## Inferences` / `## Procedures` / `## Payload`, each appearing only when the source has that element), then `## Relations`. Every unit and edge carries a trailing byte-span anchor (`start..end`) into the source; a payload unit's statement is a verbatim slice, every other type's is the normalized re-expression. Restatements of one idea collapse structurally to a single unit. Word count goes down; input and output do not match line for line. Run it on a finished expository or how-to note (a vault note, a track section, a concept explainer, a practices list), not on a pure command runbook or code.

## How to use

Distillation is a two-step **emit → review → apply** flow: `distill-text` writes an interactive intermediary beside the note, you resolve its residue by checking boxes, and `distill-text apply` writes the finished note back to source. The source note is never touched until apply.

1. **Emit.** Give `distill-text` the note — a positional file path (`distill-text input.md`) or piped on stdin with `--out <dest.md>` (required for stdin, since the destination can't be inferred) — with `FIREWORKS_API_KEY` in env (the `.local/bin` wrapper fills it from the macOS Keychain; `doppler run --project claude-code --config std --` is another way). For a **vault entry named rather than pathed**, resolve the path first with `vault-query get`: `distill-text "$(vault-query get "Target distance")"`. At an interactive terminal, before anything is written, distill also offers a **typing review**: a scratch file listing each unit with its five possible types, the resolved source span pre-checked — confirm or correct each one, check the trailing gate, then press `y` (declining or a non-TTY caller skips it; units keep their extract-assigned type). On success it writes `<note>.tmp.md` beside the note and prints the **intermediary path** as stdout's only line; the footer, ending `· review: N items + gate` (or `· review: gate` when nothing needs triage), goes to stderr. Flags: `--glossary` drops the `## Abstract` head and emits the graph sections alone; `--lang ru` overrides autodetect; `--no-gate` skips the residue backstop gates. Exit codes: **0** intermediary written; **2** usage error; **3** passthrough — no intermediary, the stdout path points at a temp copy of the unmodified original (failsafe, expand-guard growth, nothing to distill), prefer the source (empty input exits 3 with nothing on stdout); **4** a prior `<note>.tmp.md` is still pending — apply it or delete it, then re-emit. On exit 3 the stdout path line is present except for empty input, where stdout is empty, so a `$status`-branching caller must not assume a path on 3.
2. **Review the intermediary.** Open `<note>.tmp.md`. Its frontmatter carries `epistemic_status: in-review`, its body is the canonical note, and above the gate it may hold a `<!-- interact: pick-any id=residue -->` block — one item per unit or coverage gap a backstop gate flagged, each carrying the verbatim source in a fenced payload. **Checkbox is the whole interface; never hand-edit content or the indentation inside a block.** The verb is pre-assigned per item — `recover` for a genuine gate failure, `keep` for one the judge couldn't grade at all:

   | item verb (already assigned) | what it targets | check the box to | leave unchecked to |
   | --- | --- | --- | --- |
   | `recover` on a `` `Term` `` target | a `## Concepts` definition failed the fidelity backstop | re-render that definition from its fenced source (spliced verbatim if the re-render fails again) | **drop the concept** from the note |
   | `recover` on a `procedure:<headword>[:idxs]` target | a `## Procedures` step-group failed directive-coverage | splice the source's directive back into those numbered steps | **drop those steps** |
   | `recover` on `thesis` | the thesis was not recoverable from the projection | replace the `## Abstract` body with the fenced source verbatim | leave the abstract as shipped |
   | `keep` | the judge returned no verdict for this item (gate-inconclusive) | ship the entry as it stands | **drop it** |
   | `recover` on any other target (an edge, a payload span, a prose list item the coverage gates flagged as dropped) | apply has no position to splice it back — **checking this box is refused (exit 2)**, never silently lost | — | keep it dropped; copy the fenced payload in by hand after apply |

   For every row, unchecked **always removes** the entry — it is never "skip silently." Then check the single `reviewed:` box in the `<!-- interact: confirm-all id=triage-final … -->` gate **last** — it is the "I looked" bit, and nothing applies until it is checked.

3. **Apply.** Run `distill-text apply <note>.tmp.md`. It verifies the gate and the stamp (the note must be unchanged since emit), fires the checked verbs, writes the finished note back to `<note>.md` (all scaffold stripped, `epistemic_status` flipped to `distilled`), and deletes the intermediary. Stdout is the note path alone; `— applied: N recovered · M kept · K removed (V verbatim)` goes to stderr. Exit **0** applied; **1** the key is missing and a checked `recover` needed the model (nothing written); **2** refused, nothing written — the gate is unchecked (`… gate 'triage-final' is not satisfied`), the note changed since emit (stamp mismatch — re-run distill), a malformed block, or a bad/already-applied path. **Apply never prompts and has no exit 3.**

At a terminal, emit also offers to finish in one sitting: it prints the review path and an `apply later with: distill-text apply <path>` hint on stderr, then waits — check the boxes in Obsidian and press `y` to apply in place, or anything else (or Ctrl-C) to leave the intermediary for a later `apply`. Piped and command-substitution callers never see either interactive moment (the typing review or this prompt) — the stdout path line is all they get, so the flow above is unchanged for scripts.

## What it does

1. **Extract** the typed idea-graph (`gpt-oss-120b`): units of each of the five knowledge-element types, every one carrying the FINAL normalized re-expression (`statement`) and the verbatim **source quote** it was distilled from — nothing downstream rewrites a unit's wording. Restatements of one concept collapse to a single entry. A block that is deterministically payload-dense (code, commands, a wikilink-reference list — graded separately, drop/distill/retain) is held out and rendered as a `## Payload` unit instead of being fed to extraction.
2. **Locate.** Every unit's source quote is resolved against the note's bytes into a `start..end` span; a quote that cannot be found HARD-ABORTS the run, before any projection — the earliest possible anti-hallucination check, and the one no-catch failure that is not a passthrough.
3. **Typing review** (interactive terminal only): the reviewer confirms or corrects each unit's type against its own resolved source span — the one place semantic taste re-enters an otherwise-deterministic pipeline. Skipped for any non-TTY caller.
4. **Project.** Render the seven-section canonical markdown from the graph. `--glossary` omits the `## Abstract` head; a source note whose own frontmatter is `type: reference` keeps the head but suppresses `## Relations` (a reference body stays link-free).
5. **Backstop gates**, residue-only, running against the finished projection — none of them repair or rewrite, they only surface what didn't make it in: a **fidelity backstop** (`glm-5p2`, the **different** model from extraction) round-trips each `## Concepts` definition against its source span in both directions (does the definition state what the source says the concept **is**, and invent nothing — relations, rationale, and examples ride the prose-free `## Abstract`, not the definition, so omitting them is never "missing"), and checks every `## Procedures` step-group for directive coverage (does every source directive appear as a step, judged as a set per shared source block); a **prose-list-item gate** catches an explicit list item under a heading that the projection dropped; a deterministic **payload-coverage check** catches a source payload span the projection dropped. A gate that cannot parse a verdict marks that item `gate-inconclusive` and surfaces it unverified rather than dropping the whole run to passthrough. Rides the `--no-gate` switch (all three).

## Render a prose note from a glossary (separate, on-demand)

`distill-text prose <file>` runs the inverse: it reconstructs a flowing **prose note** from an already-distilled note's `## Abstract` + `## Concepts`.

- **Input**: a distilled file — this tool's own output (the `<result>…</result>` wrapper is stripped) or a saved canonical note. It reads the frontmatter, the `## Abstract` orientation, and each `### headword` definition under `## Concepts`. A note with no `## Concepts` section skips (exit 3, `no ## Concepts section found` on stderr).
- **Output**: frontmatter verbatim, then flowing prose grounded **only** in the abstract + concept definitions (no claim, term, or example absent from them), then every OTHER section verbatim — `## Judgements`, `## Inferences`, `## Procedures`, `## Payload`, `## Relations` — untouched. The `## Concepts` section itself is dropped; it is the only region reconstructed into prose. Same output contract — the temp `.md` path on stdout, the footer (`— rendered prose · 221→281 words · 5 entries`) on stderr. Any other skip (empty prose, error) also exits 3 (output = the unmodified original), reason on stderr.
- **Passes / flags**: reuses the four revise (writing-pass) stages — `--no-revise` skips them — and honors `--lang`. It is **not** fidelity-gated — there is no `<residue>`; the concept definitions are the certified artifact, so re-ground the prose against them if a claim looks off.
- **Limit**: prose mode works from the concept definitions alone. Their relations survive only as far as the definitions' own wording carries them — `## Relations`, when present, rides along verbatim rather than being re-dissolved into the prose.

## Install / run

Requires `FIREWORKS_API_KEY` (e.g. via `doppler run --project claude-code --config std --`).

```bash
distill-text input.md                      # emit input.tmp.md beside the note
distill-text apply input.tmp.md            # write the reviewed result back to input.md
distill-text < input.txt --out out.md      # stdin: --out names the destination (required)
distill-text "$(vault-query get "Entry name")"  # vault entry resolved by name → path
distill-text --glossary input.md          # graph sections only, no ## Abstract head
distill-text --lang ru input.md            # force the Russian rubric
distill-text --no-gate input.md            # skip the residue backstop gates
distill-text prose glossary.md             # separate: prose note FROM an already-distilled note (no gate)
```

The binary is `distill-text`; it is on PATH via `.local/bin/distill-text`. Emit's stdout is exactly the data — one line, the intermediary path (nothing on empty input); the footer and every other diagnostic go to stderr. Capture is plain: `path=$(distill-text input.md); status=$?`. Then branch on `$status`: 0 = intermediary at `$path` (review it, then `distill-text apply "$path"`), 3 = passthrough, `$path` is a temp copy of the unmodified original (prefer the source), 4 = a pending `input.tmp.md` already exists (apply or delete it), 2 = usage error, 1 = missing key.

## Limits

- **Scope**: built for expository prose (notes, concept explainers, track sections). On a short or list-heavy note the expand-guard reverts rather than shipping a larger note — exit 3, footer notes the revert; prefer the original.
- **Latency**: ~20–40 s (extract + locate + project + the three backstop gates). Built for a generous budget, not an interactive hook. `--no-gate` trades fidelity checking for speed.
- **Abstractive risk**: distill writes new text, so a unit's statement can drift from or invent against the source. The fidelity backstop catches and surfaces this for `## Concepts` definitions and `## Procedures` steps; drift inside the `## Abstract` head — the one authored, unanchored block — still escapes it.
- **Procedure granularity**: a `## Procedures` step-group is gated as a set per shared source block, so a practices list written without blank lines between items (one block) is judged whole; a procedure whose steps are separated into distinct blocks is gated step by step. Formatting the source into discrete steps buys finer residue pinpointing. Per-step spans are not yet tracked (only the whole procedure's span is), so a recovered/removed step-group residue item addresses the whole procedure, not an individual step.
- **Rationale rides on the source, never synthesized**: a procedure step keeps the source's _why_ when the source states one, and the gate forbids inventing a reason the source omits. A guide whose load-bearing reasoning is never stated outright still loses it; that gap is a missing source claim, not a gate failure.
- **Failsafe**: a parse error or timeout in extract/locate → passthrough (original text, footer notes the skip, no intermediary written). A backstop-gate parse failure degrades to `gate-inconclusive` residue instead — the distillation still ships. A missing API key exits non-zero with a clear message rather than passing through; every compress-mode passthrough exits 3 (empty input additionally prints nothing on stdout), while a `prose` skip (no `## Concepts` section, empty prose, transient error) also exits 3, reason on stderr.
- **Pending intermediary**: emit refuses (exit 4, nothing on stdout, before any model call) when `<note>.tmp.md` already exists — an interrupted review is a pending decision, not garbage. Apply it (`distill-text apply <note>.tmp.md`) or delete it, then re-emit. Apply consumes the intermediary on success; re-applying an already-applied note fails with exit 2 (`no intermediary at … — already applied, or re-run distill`).
- **In-vault indexing**: the `<note>.tmp.md` intermediary is excluded from `vault-query` search/consult by a `*.tmp.md` suffix rule in `.vaultignore` — but that rule only takes effect once the `vault-query` binary is rebuilt (it is a nix-store build, unlike `distill-text`, which runs live from the repo). Until then a half-reviewed intermediary can surface in consult results.

---

# polish-text

`polish-text` copy-edits a markdown note without compressing it, adding a glossary, or applying a fidelity gate — the original claims stay unchanged. It shares distill's writing-core (`src/core/writing/`): four writing passes (`revise()`), then a spell/grammar pass, typography normalization, and a self-consistency **name lint** (flags a name spelled inconsistently across the note). Reference spans are masked before rewriting so links and citations pass through untouched. Frontmatter passes through verbatim. There is no `<result>` envelope and no residue channel — the output IS the file content.

The input file is never modified; the write-back is the reviewer's act, not the tool's. Failsafe mirrors distill: a truncation or transient throw escaping the passes ships the ORIGINAL input with a "polish skipped" footer rather than aborting; a non-transient throw (a code bug) propagates.

```bash
polish-text input.md                 # polished note → stdout (exact bytes), report → stderr
polish-text input.md > out.md        # composes: stdout is the file content
polish-text < input.md               # stdin when no path (or '-')
polish-text --lang ru input.md       # force the Russian rubric (default: auto-detect)
polish-text --no-revise input.md     # skip the four writing passes
polish-text --no-spell input.md      # skip the spell/grammar pass
polish-text -o input.md              # write to a fresh temp .md; stdout: the path, then the footer
polish-text --help                   # full CLI surface
```

Exit codes: **0** polished · **2** usage error · **3** passthrough (failsafe or empty input — the output is the unpolished input). Needs `FIREWORKS_API_KEY` (the wrapper fills it from the Keychain).

---

# card-stage

`card-stage` reads one already-emitted distilled note (a file path, never a live `distill()` call) and stages a review file per extraction candidate under a card-staging inbox. Every candidate is staged **regardless** of its band verdict or any recall/judge/draft flag — nothing here gates or drops; a staging file is a review packet, never a committed card.

Per candidate the flow is: fetch neighbours from the vault (a spawn/parse failure degrades to a recall-unavailable flag with empty hits, never a throw) → a **novelty-band judge** on the fidelity model (a failure or unparseable reply degrades to a judge-inconclusive flag, verdict null) → a **card draft** on the extract model (a failure or empty reply degrades to a draft-failed flag, empty draft) → build the staging record → render → write. A programmer bug (a real `Error`, not a transient/truncation flake) propagates and aborts the run rather than being swallowed.

```bash
card-stage note.md                                # stage every candidate under the inbox
card-stage note.md --dry-run                      # enumerate + fetch neighbours only; no LLM call, writes nothing
card-stage note.md --staging-dir <dir>            # where staging files land (default: <vault-root>/00 inbox/card-staging)
card-stage note.md --vault-root <dir>             # the vault root recall searches (default: $HOME/Documents/vault)
card-stage note.md --top-k <n>                    # neighbours to recall per candidate (default: 5)
card-stage note.md --source <file.md>             # the durable source entry when note.md is a temp file
card-stage --help                                 # full CLI surface
```

`--dry-run` prints a per-candidate report (term, arm, neighbour count) instead of staging anything. Needs `FIREWORKS_API_KEY`.
