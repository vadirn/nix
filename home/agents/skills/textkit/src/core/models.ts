// models — textkit's model policy, decoupled PER CLIENT so each CLI (distill / polish /
// card-stage) configures its own provider+model independently. Kept out of the shared
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

// ---- polish ----
// The spell/grammar rewrite model. Defaults to luna like distill; a rewrite pass is lighter than
// graph extraction, so dial the effort down (or swap to a cheaper model) here if cost matters —
// this is independent of distill now.
export const POLISH_MODEL = openai("gpt-5.6-luna", { effort: "medium" });
export const POLISH_TOKENS = 96_000;

// ---- card-stage ----
// The card-draft writer. Its own model, independent of distill/polish.
export const CARD_DRAFT = openai("gpt-5.6-luna", { effort: "medium" });
export const CARD_DRAFT_TOKENS = 96_000;
// The novelty-band + atomicity judges — a DIFFERENT model than the writer (independence), on
// qwencloud to burn the prepaid credit, mirroring distill's fidelity choice.
export const CARD_JUDGE = dashscope("glm-5.2");
export const CARD_JUDGE_TOKENS = 16_384;
