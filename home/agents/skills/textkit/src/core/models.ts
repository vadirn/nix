// models — textkit's model policy, decoupled PER CLIENT so each CLI (distill / card-stage /
// simplify) configures its own provider+model independently. Kept out of the shared
// transport (`@skills/llm/llm.ts`), which is provider-neutral and takes a ModelRef + token
// cap as call arguments; these are textkit's choices, built here with the transport's provider
// helpers and passed in at every call site. Change a client's model by editing its block below
// — a shared writer function (revise) takes the model as a parameter so two clients can drive
// it with different models.
import { dashscope, openai } from "@skills/llm/llm.ts";

// ---- distill ----
// EXTRACT rides the extract/grade/revise passes: gpt-5.6-luna on OpenAI at medium reasoning
// effort. Chosen after a ten-model sweep — the one current, first-party model that keeps the
// dense OpenAI-lineage extraction (5 concepts + bullets) AND serves reliably (no runaway),
// unlike gpt-oss-120b on Fireworks whose runaway rate climbed under load. Medium is the
// cost/quality sweet spot (low unstable, high over-reasoned); its ~1.7-2.1k reasoning tokens
// keep it cheaper than gpt-5.4-mini despite the tier.
export const DISTILL_EXTRACT = openai("gpt-5.6-luna", { effort: "medium" });
export const DISTILL_EXTRACT_TOKENS = 96_000;
// Per-call abort ceiling for the EXTRACT stage, over the transport's 180s default. luna at
// medium completes in ~20-30s; this leaves headroom while still catching a genuine hang before
// 180s, and a timeout re-rolls via the transport's retry.
export const DISTILL_EXTRACT_TIMEOUT_MS = 150_000;
// FIDELITY is glm-5.2 on qwencloud — a DIFFERENT model than EXTRACT (and a different provider),
// so the fidelity backstop is not grading the same model's own output. On qwencloud to burn the
// prepaid credit; it thinks hard on the full-projection gate input (~90-150s/call), the price of
// its judgment (~90-180s/call — observed ~179s in the wild, above the estimate). Swap to a faster
// fidelity model, or cap thinking_budget, here if that latency bites.
// thinking_budget caps the inlined reasoning so it cannot exhaust DISTILL_FIDELITY_TOKENS before
// the JSON verdict lands. Without it glm-5.2 runs thinking-on by default, and every gate call
// degraded to "no verdict" — the reasoning ate the whole budget / the 320s ceiling.
export const DISTILL_FIDELITY = dashscope("glm-5.2", { thinking: { budget: 12_000 } });
// Token budget for the FIDELITY thinking model. Its reasoning is inlined in the content, so the
// cap must cover BOTH the thinking and the trailing JSON — too low and it exhausts mid-thought,
// returning prose with no `{`, which fails extractJson and drops the run to the passthrough
// failsafe. Sized with headroom for the longest gate input.
export const DISTILL_FIDELITY_TOKENS = 16_384;
// Per-call ceiling for the advisory fidelity/workflow gate. The gate runs at attempts=1 (it
// degrades safe rather than re-rolling), and its healthy call sits near the old 180s default
// (observed ~179s), so a genuinely-slow-but-working judge was landing a hair under the cliff.
// Give the single attempt real headroom so it LANDS a verdict instead of degrading to
// gate-skipped; attempts=1 bounds the total wait at this value, with no retry behind it.
export const DISTILL_FIDELITY_TIMEOUT_MS = 480_000;

// ---- card-stage ----
// The card-draft writer. Its own model, independent of distill.
export const CARD_DRAFT = openai("gpt-5.6-luna", { effort: "medium" });
export const CARD_DRAFT_TOKENS = 96_000;
// The novelty-band + atomicity judges — a DIFFERENT model than the writer (independence), on
// qwencloud to burn the prepaid credit, mirroring distill's fidelity choice.
export const CARD_JUDGE = dashscope("glm-5.2");
export const CARD_JUDGE_TOKENS = 16_384;

// ---- simplify ----
// The Simplified-restyle pass: ONE strong pass fills the seven-key brief (verdict, cut, change,
// shape, keep, borderline, rewrite). gpt-5.6-luna on OpenAI at medium effort replaced qwen-flash
// after a dogfooding sweep over one PR body (11 models, then luna vs gpt-5.6-terra at 3 runs each),
// scored by claim-level entailment — is each source claim still asserted anywhere in the rewrite? —
// with gpt-5.4 judging, so no swept model graded itself.
//   - qwen-flash DELETED a load-bearing claim in 2 of 2 runs, and its brief still read
//     "All checks passed": the deterministic guard cannot see a dropped sentence. glm-5.2 did the
//     same. Cheap Alibaba tiers (qwen-flash, qwen3.7-flash) drop; the max tiers instead shift claims.
//   - luna dropped NOTHING across 4 runs and weakened nothing, matching terra's fidelity.
//   - Price decided the tie: luna is $0.20/$1.20 per 1M vs terra's $2.00/$12.00, and terra also
//     burns 1.45x the output tokens, so a run costs ~$0.0045 on luna against ~$0.065 on terra —
//     14x — for no measured fidelity gain. luna also runs ~1.7x faster (28s vs 48s).
export const SIMPLIFY_MODEL = openai("gpt-5.6-luna", { effort: "medium" });
// The whole restyled note rides back in one JSON `rewrite` string (report-brief's transport
// choice), a larger single output than polish's per-block revise. So the cap is generous — a long
// note must land the full rewrite before a length-truncation, which the CLI surfaces as a failure.
// Sized like the other luna clients here because it is a reasoning model: max_completion_tokens
// covers BOTH the reasoning and the JSON, and a measured run spends ~2.3k of it on reasoning alone.
export const SIMPLIFY_TOKENS = 96_000;
// gpt-5.4-mini is the cheap same-provider fallback (one key with the primary). The CLI re-rolls to
// it once when the primary throws transient/truncation, before it fails the run. It dropped no claim
// in the sweep — the property that matters in a fallback, since a degraded run must not silently
// lose an argument. Keeping the fallback OFF DashScope also leaves the meaning judge below on a
// different provider than BOTH restyle models, so the judge stays independent even mid-fallback.
export const SIMPLIFY_FALLBACK = openai("gpt-5.4-mini", { effort: "medium" });
// RETIRED: the advisory `meaning` axis (a model judge over the brief's change pairs) and its
// SIMPLIFY_MEANING_MODEL / SIMPLIFY_MEANING_TOKENS. Dogfooding retired it on two grounds, both
// properties of the axis rather than of any one restyle model:
//   - It was blind to the failure that mattered. It judged only the pairs the model REPORTED in
//     `change`, so a wholesale deletion was never submitted to it. qwen-flash and glm-5.2 each
//     deleted a load-bearing sentence and the axis passed them clean.
//   - It fired on nearly every run, so it carried no signal. Three runs on a compliant body raised
//     4, 3, and 2 findings, almost all of them a bold FRAGMENT gaining a subject ("A different
//     model, for independence." → "…provides independence.") — the style working, read as a claim.
// An always-on advisory also suppressed the "All checks passed." lead permanently, costing the five
// deterministic axes their summary line. Restyle fidelity now rests on the model choice (see
// SIMPLIFY_MODEL) and on the two prompt clauses the same sweep produced: claim FORCE and a bounded
// cut licence. If a replacement is ever wanted, check DELETION only — an absent claim is objective,
// while "weakened" proved unreliable in evaluation (one judge called "showed" a weakening but let
// "exposed" pass on the same claim).
