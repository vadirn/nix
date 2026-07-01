#!/usr/bin/env bun
// distill — abstractive idea-compression: re-express a note as readable prose
// backed by a certified glossary.
//
// Not extractive (cut's verbatim-survivor trim, retired). distill rebuilds the
// note around a canonical form. By default the output is a readable note: flowing
// connective prose (which carries the THESIS and the RELATIONS among terms) above
// a `## Glossary` table of DEFINITIONS ONLY — division of labor, no duplication.
// Only operational tokens (commands, paths, flags, code) are kept verbatim.
// Restatement collapses structurally (N surface forms of one idea → one entry).
// `--core-only` drops the prose and emits just the glossary (tie + definitions).
//
// Two certified channels share the pipeline: the GLOSSARY (declarative — concepts
// to know) and the WORKFLOW (procedural — directives to do). The glossary cannot
// hold a practice or a procedure step, so a note's actionable payload used to
// dissolve; the workflow channel is its sink. It is optional — empty when the note
// prescribes nothing, in which case no `## Workflow` section is emitted.
//
// Pipeline (5 stages): segment → (1) extract combo {description, thesis, glossary
// with relations + source pointers, workflow steps + source pointers} (gpt-oss-120b)
// → (2) grade each block drop/distill/retain (gpt-oss-120b) → (3) synthesize
// glossary defs AND tighten workflow steps via the fidelity dial render|regenerate,
// then write the connective prose head from the defs+relations → (4) revise the
// distilled prose + steps (4 writing passes) → (5) fidelity-grade the glossary defs
// AND the workflow steps ⟷ raw-input by round-trip entailment with a DIFFERENT model
// (glm-5p2); residue is re-rendered from source, capped, then surfaced. Independence
// of writer (EXTRACT) and grader (FIDELITY) is the safety property — the verbatim
// certificate is gone, so the gate is equivalence. The gate certifies the glossary
// definitions and the workflow steps; the prose, which restates none of them, rides
// on those certified items and is not separately gated. Output order is prose →
// `## Workflow` → `## Glossary` → retained-verbatim.
//
// Output: written to a fresh temp .md file (mktemp), XML-wrapped. <result>…</result>
// holds exactly the text to write back to source (frontmatter verbatim + distilled
// body); <residue>…</residue> (omitted when empty) holds one <entry> per definition
// or step-group that failed the gate, with verbatim <source>, so a parent can re-read
// it. A `gate-inconclusive:` reason marks an item the judge could not grade (it
// returned no parseable verdict): the distillation still ships, that item just rides
// surfaced-but-unverified — a judge flake never discards the whole run. stdout is two
// lines — the file path, then a one-line summary footer. Failsafe: any error before
// the gate → the temp file holds the original text (passthrough), path still printed.
//
// Standalone headless CLI. Fireworks via FIREWORKS_API_KEY (e.g.
// `doppler run --project claude-code --config std --`).
//
// Usage (full text: distill-text --help):
//         distill-text input.md                      # prose + ## Glossary (auto-detect language)
//         distill-text < input.txt                   # read from stdin
//         distill-text --core-only input.md          # glossary only (tie + definitions), no prose
//         distill-text --lang ru < input.txt         # force Russian rubric
//         distill-text --synth regenerate input.md   # denser dial (default: render)
//         distill-text --max-retries 1 input.md      # cap stage-5 recovery (default: 2)
//         distill-text --tau 0.6 input.md            # payload-density routing threshold (default: 0.5)
//         distill-text --no-gate input.md            # skip stage-5 fidelity gate
//         distill-text --no-revise input.md          # skip stage-4 writing passes
//         distill-text --no-expand-guard input.md    # disable the expand-guard (alias of --max-words 0)
//         distill-text --max-words 0 input.md        # disable the expand-guard (debugging: see the model's output even if it grew)
//         distill-text --dry-run input.md            # deterministic front half only (segment→route report); no API call
//         distill-text render glossary.md            # separate, on-demand: prose note FROM a distilled glossary
//
// Module layout (split along the pipeline's phase seams; this file is the entrypoint
// and the stable public surface): text · frontmatter · fw · prompts · assemble ·
// render-mode · pipeline. The four exports below are the public API the test suite
// (and any importer) depends on; everything else is an internal module detail.
export { REL_REGISTRY, slugSegment } from "./text.ts";
export { ensureEpistemicStatus } from "./frontmatter.ts";
export { emitRelationsBlock } from "./assemble.ts";

import { main } from "./pipeline.ts";

// Guard the CLI entrypoint so test imports (e.g. distill.test.ts importing
// REL_REGISTRY) can load this module without running the pipeline against stdin.
if (import.meta.main) main();
