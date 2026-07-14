#!/usr/bin/env bun
// distill — abstractive idea-compression: extract a note's typed knowledge graph and
// project it as a certified, span-anchored canonical note.
//
// Not extractive (cut's verbatim-survivor trim, retired). distill rebuilds the note
// around a canonical form: a typed, span-anchored graph over five knowledge-element
// types — concept / judgment / inference / procedure / payload — of
// which markdown is one projection. By default the output is the seven-section
// canonical note: an unanchored `## Abstract` orientation, then `## Concepts` /
// `## Judgements` / `## Inferences` / `## Procedures` / `## Payload` (a section
// appears only when the source has that element), then `## Relations`. Every unit
// and edge carries a trailing byte-span anchor (`start..end`) into the source; a
// payload unit's statement is a verbatim slice, every other type's is the normalized
// re-expression. `--glossary` drops the `## Abstract` head; a source note whose own
// frontmatter is `type: reference` keeps the head but suppresses `## Relations`
// (a reference body stays link-free; automatic from the source frontmatter, not a
// flag). Restatement
// collapses structurally (N surface forms of one idea → one unit).
//
// Pipeline: extract(native typed units + per-unit source
// quotes, gpt-oss-120b) → locate(resolve each quote to a byte span against the
// source; a bad quote HARD-ABORTS here, before any projection) → [TTY-gated typing
// review: at an interactive terminal, the reviewer confirms each unit's type against
// its resolved source slice and re-types where wrong — skipped for any non-TTY
// caller, so the default pipeline stays extract→locate→project] → project(render the
// seven-section markdown). What survives of the old settle chain (synth/revise/
// fidelity-gate) is only the gates' VERDICT half, demoted to a residue-only backstop
// that runs AFTER projection: a fidelity backstop (glm-5p2, the different model, by
// round-trip entailment against the projection body), a prose-list-item coverage
// gate, and a deterministic payload-coverage check. None of them repair or rewrite —
// extract's statement is final — they only surface what didn't make it into the
// projection as `<residue>`, never silently drop it.
//
// Output: a distilled run writes an interactive review intermediary sibling to the
// destination, `<dest>.tmp.md` — a decision block per residue item (recover/keep)
// plus a mandatory confirm-all gate; `distill-text apply <path>` resolves it and
// writes the finished note back to source. A passthrough run (failsafe, expand-guard,
// nothing to distill) instead writes a fresh temp .md holding the legacy envelope:
// <result>…</result> is exactly the text to write back to source; <residue>…</residue>
// (omitted when empty) holds one <entry> per item a backstop flagged, with verbatim
// <source>. A `gate-inconclusive:` reason marks an item the judge could not grade (it
// returned no parseable verdict): the distillation still ships, that item just rides
// surfaced-but-unverified — a judge flake never discards the whole run. stdout is
// exactly the data: one line, the file path; the one-line summary footer and all
// other diagnostics go to stderr. Failsafe: any error before the backstop gates →
// the temp file holds the original text (passthrough), path still printed.
//
// Exit codes: 0 an intermediary was written, or (passthrough/prose) distilled/rendered
// (residue/gate-inconclusive stay 0); 1 missing key; 2 arg misuse; 3 passthrough — the
// output is the unmodified original (compress: failsafe, expand-guard, no body, empty
// input; prose: no `## Concepts` section, empty prose, error); 4 a prior `<dest>.tmp.md`
// is still pending. The stdout path line still prints except on empty input; the skip
// reason goes to stderr.
//
// Standalone headless CLI. Fireworks via FIREWORKS_API_KEY (e.g.
// `doppler run --project claude-code --config std --`).
//
// Usage (full text: distill-text --help):
//         distill-text input.md                      # seven-section canonical note (auto-detect language)
//         distill-text < input.txt --out out.md       # stdin: --out names the destination
//         distill-text --glossary input.md           # graph sections only, no ## Abstract head
//         distill-text --lang ru input.md             # force Russian rubric
//         distill-text --tau 0.6 input.md            # payload-density routing threshold (default: 0.5)
//         distill-text --no-gate input.md            # skip the residue backstop gates
//         distill-text --max-words 0 input.md        # disable the expand-guard (debugging: see the model's output even if it grew)
//         distill-text --dry-run input.md            # deterministic front half only (segment→route report); no API call
//         distill-text prose glossary.md             # separate, on-demand: prose note FROM an already-distilled note
//         distill-text apply input.tmp.md            # resolve a review intermediary, write the note back to source
//
// Module layout (split along the pipeline's phase seams; this file is the entrypoint
// and the stable public surface): text · frontmatter · fw · graph · prompts ·
// locate(-graph) · retype (the typing review) · project · parse-projection ·
// interact/triage (the review grammar) · apply-mode · prose-mode · writing/
// (writing-core: typography, mask, passes) · distill-core (the orchestration core:
// compress/route/main) with its carved-out concerns gates (residue backstops) · cli
// (arg parsing + path helpers) · tty (interactive terminal halves). The four exports
// below are the public API the test suite (and any importer) depends on; everything
// else is an internal module detail.
export { REL_REGISTRY, slugSegment } from "./text.ts";
export { ensureEpistemicStatus } from "./frontmatter.ts";

import { main } from "./distill-core.ts";

// Guard the CLI entrypoint so test imports (e.g. distill.test.ts importing
// REL_REGISTRY) can load this module without running the pipeline against stdin.
if (import.meta.main) main();
