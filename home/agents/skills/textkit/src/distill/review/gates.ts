// gates — the demoted, residue-only backstop gates. The canonical pipeline
// runs these AFTER projectMarkdown: they never repair or mutate, only surface what did not
// survive into the projection as residue. runFidelityBackstop judges the projection body
// against each concept/procedure unit's located source slice; runProseGate matches the
// harvested prose-list inventory (glm, batched). The deterministic loss-surface primitives
// they build on (proseResidue et al.) live in residue.ts.
import { sliceBytes, type Span } from "@/distill/mdstruct.ts";
import { type Projection } from "@/distill/graph/project.ts";
import {
  type ConceptVerdict,
  type GateGrade,
  type StepVerdict,
  fidelityGate,
  proseGate,
  workflowGate,
} from "@/distill/prompt/prompts.ts";
import { type ProseUnit } from "@/distill/extract/harvest.ts";
import { type Residue, proseResidue } from "@/distill/review/residue.ts";
import { normalizeCitation } from "@/distill/review/normalize-citation.ts";
import { askJson } from "@/core/fw.ts";

// Shared inconclusive→residue mapping: both the concept and workflow verdict loops below grade
// "inconclusive" identically (a `gate-inconclusive:` reason, surfaced-but-unverified) and derive
// `reasonClass` the same way off that one distinction. The two loops still vary on `kind` and on
// the non-inconclusive reason text (concepts prefix a per-item `direction`, groups a fixed
// "workflow", each with its own missing-fallback), so callers build `failReason` themselves and
// hand it in pre-interpolated rather than have this helper guess at a shared template.
function verdictResidueFields(
  v: { grade: GateGrade; missing: string },
  opts: { kind: Residue["kind"]; failReason: string },
): Pick<Residue, "kind" | "reason" | "reasonClass"> {
  const inconclusive = v.grade === "inconclusive";
  return {
    kind: opts.kind,
    reason: inconclusive
      ? `gate-inconclusive: ${v.missing || "judge returned no verdict"}`
      : opts.failReason,
    reasonClass: inconclusive ? "gate-inconclusive" : "failed",
  };
}

// The deterministic citation floor (Backlog 23). A judge's `evidence` BACKS a verdict only when it
// is a literal span of the target source — compared through `normalizeCitation`, the gentle fold
// that strips markdown markup but PRESERVES prose punctuation, so a numeric/symbolic distortion
// cannot slip past. Empty (or markup-only) evidence is NEVER a match: `normalizeCitation("") === ""`
// and every string `.includes("") === true`, so the empty case must be rejected explicitly — an
// uncited grade is exactly the cheap, unjustified pass this check exists to catch. Scope honesty: a
// PASS proves the cited span is PRESENT in the source, not that it entails the OUTPUT's claim.
function citationBacked(evidence: string, source: string): boolean {
  const needle = normalizeCitation(evidence);
  if (needle === "") return false;
  return normalizeCitation(source).includes(needle);
}

// Evidence-forced downgrade of a "translated" verdict. Returns null when the citation is backed
// (keep skipping — a citation-backed translation). Otherwise returns the inconclusive coercion
// (grade + a reason-carrying `missing`) that routes the verdict through `verdictResidueFields`'
// existing inconclusive path — no new residue state. SOURCE is the target regardless of mismatch
// direction: the downgrade fires on the "translated" grade alone, and the plan's grade+direction
// keying routes "translated" to SOURCE, so direction never selects the target here (the reason a
// procedure verdict needs no `direction`). The reason keeps the integrity-not-entailment framing:
// the run is surfaced because the citation could not be VERIFIED, not because the claim was
// disproved.
function uncitedDowngrade(
  evidence: string,
  source: string,
): { grade: "inconclusive"; missing: string } | null {
  if (citationBacked(evidence, source)) return null;
  return {
    grade: "inconclusive",
    missing:
      normalizeCitation(evidence) === ""
        ? "translated grade left uncited (empty evidence) — unverifiable (citation integrity, not entailment)"
        : "translated grade cited a span absent from source — unverifiable (citation integrity, not entailment)",
  };
}

// ---- the DISTILL_FIDELITY_ENSEMBLE leaf (Backlog 23) --------------------------------------------
// Opt-in "paranoid mode": run each fidelity judge ENSEMBLE_N times at ENSEMBLE_TEMP and fold with
// ANY-INVENTION voting — a unit keeps "translated" only when EVERY run graded it translated AND
// every run's citation is a literal source span; a single dissenting run (grade residue/inconclusive
// OR a citation that fails the Step-3 substring floor) wins the non-translated outcome. Default OFF
// for two independent reasons: (1) it is DOWNSTREAM of the residual-invention measurement (Log 10) —
// nothing yet proves invention survives the Step-3 citation floor, so paying 3× is unjustified; and
// (2) temp > 0 breaks emit→review→apply reproducibility, since the same note then yields different
// residue boxes, violating the pending-intermediary contract. OFF is exactly the single temp-0 call.
//
// KILL CONDITION — this flag is EXPLICITLY TEMPORARY and must be removed on BOTH outcomes, never left
// standing. Measure on the labelled gold set whether invention still slips past the Step-3 citation
// floor (a false "translated" on a known-invention unit), then collapse to ONE branch and delete the
// flag:
//   - residual invention survives citation-forcing → promote the ensemble to the default, DELETE the
//     off path (the single temp-0 call);
//   - none survives → DELETE this on path (the ensemble code), keep the single call.
// A flag that "measures then flips" rots into permanent debt when the measurement is never scheduled,
// so deletion is mandatory under either result — the removal criterion, not the flag, is the contract.
const ENSEMBLE_N = 3;
const ENSEMBLE_TEMP = 0.4;

// Read at call time (not module load) so runFidelityBackstop's `ensemble` param can DEFAULT to the
// env while a test overrides it per-call without process-global env mutation (mirrors fidelityGate's
// `defGate`). "Set" means any non-empty value other than the explicit off spellings.
function ensembleEnabled(): boolean {
  const v = process.env.DISTILL_FIDELITY_ENSEMBLE;
  return v !== undefined && v !== "" && v !== "0" && v !== "false";
}

// Bind a sampling temperature onto an injected transport by threading it through askJson's trailing
// `temp` param, reusing the existing `ask` seam rather than widening every gate signature. A test
// fake ignores the extra args; the real askJson forwards temp to fw. The `as typeof askJson` cast
// matches the throwsAsk/askBy idiom (degradation.test.ts) — the generic T is erased through closure.
const withTemp = (ask: typeof askJson, temp: number): typeof askJson =>
  ((model: string, prompt: string, maxTokens: number) =>
    ask(model, prompt, maxTokens, undefined, temp)) as typeof askJson;

// Any-invention fold of ONE unit's verdicts across the ensemble runs (concept or step — both carry
// grade + evidence). Pure SELECTION among the runs' own verdicts, never a synthesized grade, so the
// downstream Step-3 downgrade (uncitedDowngrade) consumes the result UNCHANGED:
//   - all runs graded "translated": forward a run whose citation is NOT a source span if one exists,
//     so the existing downgrade fires (any citation fails → surface); else the first (citation-backed)
//     translated verdict, which stays skipped (unanimous AND all-cited);
//   - otherwise: a concrete "residue" finding beats an "inconclusive" flake beats the first run.
function foldVerdict<V extends { grade: GateGrade; evidence: string }>(vs: V[], source: string): V {
  if (vs.every((v) => v.grade === "translated")) {
    return vs.find((v) => !citationBacked(v.evidence, source)) ?? vs[0]!;
  }
  return (
    vs.find((v) => v.grade === "residue") ?? vs.find((v) => v.grade === "inconclusive") ?? vs[0]!
  );
}

// Fan out both fidelity lanes ENSEMBLE_N times at ENSEMBLE_TEMP (all runs concurrent) and fold each
// unit's verdicts. Preserves runFidelityBackstop's empty-lane short-circuits (no judge call when a
// lane is empty) and returns the SAME [{thesisRecoverable,concepts}, StepVerdict[]] shape the
// single-call path returns, so the caller's residue loops are byte-identical on both paths.
async function runFidelityEnsemble(
  thesis: string,
  out: string,
  concepts: { term: string; def: string; sourceText: string }[],
  groups: { id: string; steps: string[]; sourceText: string }[],
  lang: "en" | "ru",
  ask: typeof askJson,
): Promise<[{ thesisRecoverable: boolean; concepts: ConceptVerdict[] }, StepVerdict[]]> {
  const hot = withTemp(ask, ENSEMBLE_TEMP);
  const runs = Array.from({ length: ENSEMBLE_N });
  const [conceptRuns, groupRuns] = await Promise.all([
    concepts.length
      ? Promise.all(runs.map(() => fidelityGate(thesis, out, concepts, hot)))
      : Promise.resolve([] as { thesisRecoverable: boolean; concepts: ConceptVerdict[] }[]),
    groups.length
      ? Promise.all(runs.map(() => workflowGate(groups, lang, hot)))
      : Promise.resolve([] as StepVerdict[][]),
  ]);
  // thesis stays recoverable only if EVERY run agrees — a single "not recoverable" run surfaces it.
  const thesisRecoverable = conceptRuns.every((r) => r.thesisRecoverable);
  const conceptTerms = [...new Set(conceptRuns.flatMap((r) => r.concepts.map((c) => c.term)))];
  const foldedConcepts = conceptTerms.map((term) => {
    const vs = conceptRuns
      .map((r) => r.concepts.find((c) => c.term === term))
      .filter((c): c is ConceptVerdict => c !== undefined);
    const source = concepts.find((c) => c.term === term)?.sourceText ?? "";
    return foldVerdict(vs, source);
  });
  const groupIds = [...new Set(groupRuns.flatMap((r) => r.map((v) => v.id)))];
  const foldedGroups = groupIds.map((id) => {
    const vs = groupRuns
      .map((r) => r.find((v) => v.id === id))
      .filter((v): v is StepVerdict => v !== undefined);
    const source = groups.find((g) => g.id === id)?.sourceText ?? "";
    return foldVerdict(vs, source);
  });
  return [{ thesisRecoverable, concepts: foldedConcepts }, foldedGroups];
}

// The DEMOTED fidelity gate for the canonical pipeline. The retired settle-chain
// gate authored defs/steps and repaired them in a recovery loop against a scratch render; once
// extract emits the FINAL statements there is nothing to repair, so only the gate's VERDICT half
// survives here. It runs AFTER projectMarkdown, takes the projection body itself as judge input, and
// surfaces residue only — no recovery, no in-place mutation, no carriers. Each concept/procedure
// unit's span now locates the ENCLOSING mdstruct block (block-granular, resolved by `snap.ts`), so
// `sourceText` is the whole block's bytes, not the tight quote — the concept/workflow judges see
// whole-block source context, not a hallucination-tight anchor, when comparing projection ↔ source.
// Rides the `--no-gate` switch.
export async function runFidelityBackstop(
  thesis: string,
  result: Projection,
  out: string,
  body: string,
  lang: "en" | "ru",
  // Injected transport threaded from the emit pipeline (main → distill → here), so the
  // backstop's fidelity/workflow judges run off a fake without a process-global module
  // mock (see fidelityGate). Production omits it → real fw.
  ask: typeof askJson = askJson,
  // The DISTILL_FIDELITY_ENSEMBLE leaf (Backlog 23), defaulting to the env read so a test flips it
  // per-call without process-global env mutation (mirrors fidelityGate's defGate). Trails `ask` so
  // the sole production caller (distill-core.ts) is unchanged. OFF = today's single temp-0 call; ON =
  // ENSEMBLE_N calls at ENSEMBLE_TEMP with any-invention voting. See the KILL CONDITION above.
  ensemble: boolean = ensembleEnabled(),
): Promise<{ residue: Residue[]; gateSkipped: number }> {
  const buf = Buffer.from(body, "utf8");
  const concepts = result.units
    .filter((u) => u.type === "concept")
    .map((u) => ({ term: u.id, def: u.statement, sourceText: sliceBytes(buf, u.span) }));
  // one workflow group per procedure unit; its steps are the joined statement re-split, its
  // sourceText the concatenation of every step's located BLOCK (head `span` + each `subSpans`
  // entry, each now the enclosing block's bytes, not the tight quote) so the coverage judge sees
  // ALL prescribed source in whole-block context, not just the lead step — a null hole (a
  // synthesized step) contributes nothing.
  const groups = result.units
    .filter((u) => u.type === "procedure")
    .map((u) => ({
      id: u.id,
      steps: u.statement.split("\n").filter((s) => s.trim().length > 0),
      sourceText: [u.span, ...(u.subSpans ?? [])]
        .filter((s): s is Span => s !== null)
        .map((s) => sliceBytes(buf, s))
        .join("\n"),
    }));
  // The flag-OFF branch is LITERALLY today's expression — one temp-0 call per non-empty lane; the
  // flag-ON branch fans out to the ensemble. Both produce the same [graded, gradedG] shape, so the
  // residue loops below (and the Step-3 citation downgrade they run) are shared and unchanged.
  const [graded, gradedG] = ensemble
    ? await runFidelityEnsemble(thesis, out, concepts, groups, lang, ask)
    : await Promise.all([
        concepts.length
          ? fidelityGate(thesis, out, concepts, ask)
          : Promise.resolve({ thesisRecoverable: true, concepts: [] as ConceptVerdict[] }),
        groups.length ? workflowGate(groups, lang, ask) : Promise.resolve([] as StepVerdict[]),
      ]);
  const residue: Residue[] = [];
  // an unrecoverable thesis heads the residue, before the per-concept and per-workflow entries.
  if (!graded.thesisRecoverable) {
    residue.push({
      label: "(thesis)",
      reason: "thesis not recoverable from output",
      source: thesis,
      kind: "thesis",
      reasonClass: "failed",
    });
  }
  // count of "translated" verdicts the citation floor demoted to inconclusive, folded into
  // gateSkipped alongside the judge's own inconclusive verdicts (both ship surfaced-but-unverified).
  let downgraded = 0;
  for (const c of graded.concepts) {
    // The unknown-term guard now runs for EVERY grade (translated included): a translated verdict
    // also needs its source slice to validate the citation, and a term absent from the gate input
    // is a judge-contract violation with no source to check against. A verdict whose term matches
    // no judge INPUT concept would only ship an entry apply cannot recover — drop it loudly.
    const match = concepts.find((r) => r.term === c.term);
    if (!match) {
      process.stderr.write(
        `distill: fidelity judge graded unknown concept term '${c.term}' (not in gate input) — dropping\n`,
      );
      continue;
    }
    // Evidence-forced downgrade: a "translated" grade survives (stays skipped, no residue) only
    // when its citation is a literal span of the SOURCE block. An uncited or fabricated citation is
    // coerced to inconclusive and surfaced, so a cheap unjustified pass can no longer launder
    // invention past the sole anti-hallucination floor.
    let v: ConceptVerdict = c;
    if (c.grade === "translated") {
      const down = uncitedDowngrade(c.evidence, match.sourceText);
      if (!down) continue;
      v = { ...c, ...down };
      downgraded++;
    }
    residue.push({
      label: v.term,
      source: match.sourceText,
      ...verdictResidueFields(v, {
        kind: "def",
        failReason: `${v.direction || "residue"}: ${v.missing || "failed round-trip entailment"}`,
      }),
    });
  }
  for (const g of gradedG) {
    // Same all-grade unknown-id guard as the concept loop: a translated verdict needs its source
    // to validate the citation, and an id absent from the gate input has no source to check.
    const match = groups.find((gr) => gr.id === g.id);
    if (!match) {
      process.stderr.write(
        `distill: workflow judge graded unknown procedure id '${g.id}' (not in gate input) — dropping\n`,
      );
      continue;
    }
    // Mirror of the concept downgrade: "translated" survives only on a citation that is a literal
    // SOURCE span. Direction is moot — the "translated" grade routes to SOURCE regardless — so the
    // procedure gate reuses the identical check with no `direction` field (drift #1 resolution).
    let v: StepVerdict = g;
    if (g.grade === "translated") {
      const down = uncitedDowngrade(g.evidence, match.sourceText);
      if (!down) continue;
      v = { ...g, ...down };
      downgraded++;
    }
    residue.push({
      label: v.id,
      source: match.sourceText,
      ...verdictResidueFields(v, {
        kind: "steps",
        failReason: `workflow: ${v.missing || "directive coverage failed"}`,
      }),
      // per-step spans are deferred, so the canonical backstop carries no flat-list indices.
      stepIdxs: [],
    });
  }
  const gateSkipped =
    graded.concepts.filter((c) => c.grade === "inconclusive").length +
    gradedG.filter((v) => v.grade === "inconclusive").length +
    downgraded;
  return { residue, gateSkipped };
}

// runProseGate matches the harvested prose-list inventory against the projection body (glm,
// batched) and maps each verdict to prose-coverage residue; an empty inventory short-circuits
// to no residue.
export async function runProseGate(
  units: ProseUnit[],
  outputText: string,
  lang: "en" | "ru",
  // Injected transport (see runFidelityBackstop); production omits it → real fw.
  ask: typeof askJson = askJson,
): Promise<Residue[]> {
  if (units.length === 0) return [];
  const { verdicts, flaked } = await proseGate(units, outputText, lang, ask);
  return proseResidue(units, verdicts, flaked, outputText);
}
