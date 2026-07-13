// gates — the demoted, residue-only backstop gates (blueprint §4.2). The canonical pipeline
// runs these AFTER projectMarkdown: they never repair or mutate, only surface what did not
// survive into the projection as residue. runFidelityBackstop judges the projection body
// against each concept/procedure unit's located source slice; runProseGate matches the
// harvested prose-list inventory (glm, batched). The deterministic loss-surface primitives
// they build on (proseResidue et al.) live in residue.ts.
import { sliceBytes, type Span } from "./mdstruct.ts";
import { type Projection } from "./project.ts";
import {
  type ConceptVerdict,
  type GateGrade,
  type StepVerdict,
  fidelityGate,
  proseGate,
  workflowGate,
} from "./prompts.ts";
import { type ProseUnit } from "./text.ts";
import { type Residue, proseResidue } from "./residue.ts";

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

// The DEMOTED fidelity gate for the canonical pipeline (blueprint §4.2). The retired settle-chain
// gate authored defs/steps and repaired them in a recovery loop against a scratch render; once
// extract emits the FINAL statements there is nothing to repair, so only the gate's VERDICT half
// survives here. It runs AFTER projectMarkdown, takes the projection body itself as judge input, and
// surfaces residue only — no recovery, no in-place mutation, no carriers. Each concept/procedure
// unit's `sourceText` is the verbatim bytes its span locates (the anti-hallucination anchor
// `locateGraph` already resolved), so the concept/workflow judges compare projection ↔ source with
// no legacy shape. Rides the `--no-gate` switch.
export async function runFidelityBackstop(
  thesis: string,
  result: Projection,
  out: string,
  body: string,
  lang: "en" | "ru",
): Promise<{ residue: Residue[]; gateSkipped: number }> {
  const buf = Buffer.from(body, "utf8");
  const concepts = result.units
    .filter((u) => u.type === "concept")
    .map((u) => ({ term: u.id, def: u.statement, sourceText: sliceBytes(buf, u.span) }));
  // one workflow group per procedure unit; its steps are the joined statement re-split, its
  // sourceText the concatenation of every step's located slice (head `span` + each `subSpans`
  // entry) so the coverage judge sees ALL prescribed source, not just the lead step — a null hole
  // (a synthesized step) contributes nothing.
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
  const [graded, gradedG] = await Promise.all([
    concepts.length
      ? fidelityGate(thesis, out, concepts)
      : Promise.resolve({ thesisRecoverable: true, concepts: [] as ConceptVerdict[] }),
    groups.length ? workflowGate(groups, lang) : Promise.resolve([] as StepVerdict[]),
  ]);
  const residue: Residue[] = [];
  // an unrecoverable thesis heads the residue, mirroring runFidelityGate's ordering.
  if (!graded.thesisRecoverable) {
    residue.push({
      label: "(thesis)",
      reason: "thesis not recoverable from output",
      source: thesis,
      kind: "thesis",
      reasonClass: "failed",
    });
  }
  for (const c of graded.concepts) {
    if (c.grade === "translated") continue;
    residue.push({
      label: c.term,
      source: concepts.find((r) => r.term === c.term)?.sourceText ?? "",
      ...verdictResidueFields(c, {
        kind: "def",
        failReason: `${c.direction || "residue"}: ${c.missing || "failed round-trip entailment"}`,
      }),
    });
  }
  for (const v of gradedG) {
    if (v.grade === "translated") continue;
    residue.push({
      label: v.id,
      source: groups.find((g) => g.id === v.id)?.sourceText ?? "",
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
    gradedG.filter((v) => v.grade === "inconclusive").length;
  return { residue, gateSkipped };
}

// orchestrate the gate: match the harvested inventory (glm, batched) and map to residue.
export async function runProseGate(
  units: ProseUnit[],
  outputText: string,
  lang: "en" | "ru",
): Promise<Residue[]> {
  if (units.length === 0) return [];
  const { verdicts, flaked } = await proseGate(units, outputText, lang);
  return proseResidue(units, verdicts, flaked, outputText);
}
