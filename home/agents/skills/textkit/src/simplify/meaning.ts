// simplify/meaning — the advisory meaning-fidelity axis. The deterministic guard (guard.ts) checks
// mechanics — masked spans survived, code intact, no name typo, every sentence under the cap, the
// list kind held — and none of them can tell whether the rewrite kept the source's MEANING. A live
// run proved the gap: a narrative statement was recast as a command ("the tool masks spans" became
// "Run the tool to mask spans") and every mechanical axis passed.
//
// This axis closes the gap with ONE bounded model call over the brief's `change` array. Checking
// whether an `after` preserves its `before`'s speech act (tense, mood, polarity) is grounded
// entailment — the class a small model handles well — because the generator already emitted the
// certificate: each {before, after} pair. Verification is then cheap; open-ended prose would have
// no certificate and be as hard to check as to write.
//
// It is ADVISORY, like every guard axis: a finding rides the `## guard` section and never changes
// the exit code. And it is the guard's only impure part — a model call — so it lives here, apart
// from the pure mechanical axes, and DEGRADES to a clean skip when the model is unreachable (no
// key, a transient flake, a truncation). So an offline run still ships a brief; only the meaning
// line reads "skipped" instead of "OK".
import { MissingKeyError } from "@skills/llm/keys.ts";
import { askJson, isTransient, TruncationError } from "@skills/llm/llm.ts";
import { SIMPLIFY_MEANING_MODEL, SIMPLIFY_MEANING_TOKENS } from "textkit/core/models.ts";
import type { ChangeItem } from "textkit/simplify/prompt.ts";

// One meaning finding: the change pair whose speech act shifted, plus the one-clause issue the
// judge named. `before`/`after` are the human-readable (unmasked) spans, so the report cites them.
// Internal — MeaningReport carries them; consumers read the report, not this type directly.
type MeaningFinding = { before: string; after: string; issue: string };

// The meaning axis outcome. `skipped` marks a degraded run (no key, or a model flake) — kept
// distinct from a clean check so the brief says "not checked" rather than "passed". `checked` is
// how many pairs were submitted; `findings` names the pairs that shifted.
export type MeaningReport = { checked: number; findings: MeaningFinding[]; skipped: boolean };

// The JSON the judge returns: ONLY the pairs that failed, by index into the change array. A
// faithful brief yields an empty array. `findings` is validated defensively at read time — a model
// that drops the key or an out-of-range index degrades to no finding, never a crash.
type MeaningVerdict = { findings?: { index: number; issue: string }[] };

// meaningPrompt builds the single batched pass over every change pair. It asks the judge to rule on
// grounded entailment per pair — did tense, mood, and polarity survive — and to return ONLY the
// failures by index. The wording is allowed to change; only a shifted speech act is a finding, so
// a faithful restyle returns an empty array.
export function meaningPrompt(change: ChangeItem[]): string {
  const pairs = change
    .map((c, i) => `[${i}] BEFORE: ${c.before}\n    AFTER: ${c.after}`)
    .join("\n");
  return `You check meaning fidelity for a prose restyle. Each numbered pair is a BEFORE span and its restyled AFTER. The wording may change; the SPEECH ACT must not. Flag a pair ONLY when AFTER changes BEFORE's:
- tense — a record of what happened turned present or future;
- mood — a statement turned into a command or a question, or the reverse;
- polarity — an affirmation turned negative, or the reverse;
- or claim — AFTER adds or drops a claim BEFORE did not make.
Do NOT flag a pair for wording, brevity, or style alone. Only a shifted speech act is a finding.

Return ONLY JSON: {"findings":[{"index":<pair number>,"issue":"<one clause naming the shift>"}]}. Return an empty findings array when every pair kept its speech act.

PAIRS:
${pairs}`;
}

// runMeaning runs the axis: one batched model call over the change pairs, mapping each returned
// index back to its {before, after}. Empty change short-circuits before any call. It is total for
// the caller — a missing key, a transient flake, or a truncation degrades to a clean skip (the
// brief still ships), and only a genuine code bug propagates. `ask` is injected so a test drives it
// offline.
export async function runMeaning(
  change: ChangeItem[],
  deps: { ask?: typeof askJson } = {},
): Promise<MeaningReport> {
  const { ask = askJson } = deps;
  if (change.length === 0) return { checked: 0, findings: [], skipped: false };
  try {
    // attempts=1: the axis is advisory, so fail fast on the first flake rather than pay a re-roll.
    const verdict = await ask<MeaningVerdict>(
      SIMPLIFY_MEANING_MODEL,
      meaningPrompt(change),
      SIMPLIFY_MEANING_TOKENS,
      undefined,
      1,
    );
    const findings: MeaningFinding[] = [];
    for (const f of verdict.findings ?? []) {
      const item = change[f.index];
      if (item) findings.push({ before: item.before, after: item.after, issue: f.issue });
    }
    return { checked: change.length, findings, skipped: false };
  } catch (e) {
    // Advisory degrade: a missing key, a transient model flake, or a truncation skips the axis so
    // the brief still ships. Everything else is a real code bug and propagates. (MissingKeyError is
    // non-transient, so it must be named here — isTransient alone would let it escape.)
    if (e instanceof MissingKeyError || isTransient(e) || e instanceof TruncationError)
      return { checked: change.length, findings: [], skipped: true };
    throw e;
  }
}

// meaningClean reports whether the axis found no speech-act shift. A skipped run is clean (an
// advisory degrade never blocks the "All checks passed." lead — the line itself names the skip).
export function meaningClean(r: MeaningReport): boolean {
  return r.findings.length === 0;
}

// formatMeaning renders the axis as one `## guard` line: a skip, an OK (with the count checked), or
// the flagged pairs (up to three, each before→after with the issue).
export function formatMeaning(r: MeaningReport): string {
  if (r.skipped) return "- meaning: skipped — model unreachable, speech act not checked";
  if (r.checked === 0) return "- meaning: OK — no change pairs to check";
  if (r.findings.length === 0)
    return `- meaning: OK — ${r.checked} change pair(s) kept their speech act`;
  const shown = r.findings
    .slice(0, 3)
    .map((f) => `"${clip(f.before)}" → "${clip(f.after)}" (${f.issue})`);
  return `- meaning: ${r.findings.length} pair(s) shifted the speech act — ${shown.join("; ")}`;
}

// Clip a long span for the one-line finding.
const clip = (s: string): string => (s.length > 60 ? `${s.slice(0, 57)}…` : s);
