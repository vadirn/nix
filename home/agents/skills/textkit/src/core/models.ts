// models — textkit's model policy: which Fireworks model each stage rides and the
// token budget it gets. Kept out of the shared transport (`@shared/llm/llm.ts`),
// which is provider-neutral and takes model + token cap as call arguments; these
// are textkit's choices, passed in at every call site.

// EXTRACT is the fast, obedient gpt-oss model id: used for the extract, grade, and revise
// passes (~3s per call).
export const EXTRACT = "accounts/fireworks/models/gpt-oss-120b";
// FIDELITY is the slower glm thinking-model id, deliberately a DIFFERENT model than EXTRACT so
// the fidelity backstop is not grading the same model's own output: used only for that
// independent fidelity pass (~15-20s per call).
export const FIDELITY = "accounts/fireworks/models/glm-5p2";
// Token budget for the FIDELITY thinking model. Its reasoning is inlined in the
// content, so the cap must cover BOTH the thinking and the trailing JSON — too low
// and the model exhausts it mid-thought, returning prose with no `{`, which fails
// extractJson and drops the whole run to the passthrough failsafe. Sized with
// headroom for the longest gate input (rationale-carrying workflow steps).
export const FIDELITY_TOKENS = 16_384;
// Output ceiling for the content-scaling EXTRACT stages (extractGraph, gradeBlocks,
// revise, proseFix, renderProse). gpt-oss inlines reasoning in
// the content, so the budget must cover reasoning + JSON; a dense note overran the old
// per-stage caps (4096/2048) and truncated. max_tokens is a CEILING, not a target — a
// normal note generates only what its content needs (~3-5k) and costs the same at any
// ceiling, so this is sized generously to never truncate a real note. The 180s
// TIMEOUT_MS is the de-facto limit (a runaway times out long before 96k); a genuine
// length-truncation now surfaces as an actionable TruncationError, not silent loss.
// The intentionally-tiny stages (tieTogether, recover-def: ~1024) keep their small caps
// as sanity bounds.
export const EXTRACT_TOKENS = 96_000;
