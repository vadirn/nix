// pipeline — the orchestration layer: the five-stage compress pipeline (distill),
// arg parsing, the temp-file sink, and main(). Sequences the stages from prompts.ts
// behind the seams the leaf modules stabilize; main() is invoked by the entrypoint.
import { existsSync, linkSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  type Block,
  type Grade,
  type GlossEntry,
  type Combo,
  type LinkInventory,
  type ProseUnit,
  type WorkStep,
  type PayloadSpan,
  type Route,
  type RoutedSection,
  DEFAULT_TAU,
  compactSection,
  detectLang,
  formatDryRun,
  harvestBlockquotes,
  harvestCitations,
  harvestExternalLinks,
  harvestFences,
  harvestImages,
  harvestMath,
  harvestNumbers,
  harvestProseListItems,
  harvestTableRows,
  harvestVaultEdges,
  normalizeForContainment,
  partition,
  reassembleNote,
  routeNote,
  segment,
  slugSegment,
  wordCount,
} from "./text.ts";
import {
  ensureEpistemicStatus,
  parseDescription,
  parseFrontmatter,
  parseSuperseded,
  parseType,
} from "./frontmatter.ts";
import { askJson, EXTRACT, isTransient, rethrowIfBug, TruncationError } from "./fw.ts";
import {
  type ConceptVerdict,
  type StepVerdict,
  connectiveProse,
  extractCombo,
  fidelityGate,
  gradeBlocks,
  type ProseVerdict,
  proseGate,
  renderEntryPrompt,
  repairWorkflowGroup,
  sourceTextFor,
  synthEntries,
  synthWorkflow,
  tieTogether,
  verbatimDirectives,
  workflowGate,
} from "./prompts.ts";
import { normalizeTypography } from "./writing/typography.ts";
import { PASS_EN, PASS_RU, revise } from "./writing/passes.ts";
import { proseFix, proseJudge } from "./writing/prose-qa.ts";
import { formatNameLint, nameLintAgainstSource, type NameLintResult } from "./writing/name-lint.ts";
import { assembleBody, escAttr, renderWorkflowBlock } from "./assemble.ts";
import { runProse } from "./prose-mode.ts";
import { buildIntermediary } from "./triage.ts";
import { runApply } from "./apply-mode.ts";
import { parseInteract } from "./interact.ts";
import { createInterface } from "node:readline";

// Workflow-gate recovery ladder (stage-5 loop). A flagged step is repaired from
// the gate's own finding (judge-guided), then — if the repair still fails the
// re-grade within --max-retries — falls back to the source's verbatim imperative,
// a guaranteed-faithful floor (a substring of source cannot invert). Overridable
// for the recovery experiment: "retighten" re-runs the same blind compression that
// caused the inversion (the prior behavior); "repair" is judge-guided only, no
// floor; "repair-verbatim" is the full ladder and the default.
type WfRecovery = "retighten" | "repair" | "repair-verbatim";
const WF_RECOVERY: WfRecovery = ((): WfRecovery => {
  const v = process.env.DISTILL_WF_RECOVERY;
  return v === "retighten" || v === "repair" ? v : "repair-verbatim";
})();

// ---- pipeline ----
// What failed and where, carried structurally (not re-derived from the reason string)
// so triage.ts can pick the decision verb and target per entry (plan §1: D1's
// residueToBlocks + kind/stepIdxs threading).
export type ResidueKind = "def" | "steps" | "thesis" | "edge" | "payload" | "prose";
// Why the item is residue: "failed" — a gate judged it unfaithful (def/steps/thesis);
// "gate-inconclusive" — the fidelity/workflow judge returned no verdict, so the entry
// SHIPPED in the body surfaced-but-unverified (the one class triage maps to `keep:`);
// "dropped" — a coverage lane found it absent from output (incl. the wikilink
// slug-collision "verify manually" case, whose recover semantics match a drop's);
// "prose-inconclusive" — the coverage judge returned no usable verdict for an item
// that is NOT known to be in the body, so it triages as recover, not keep.
export type ResidueClass = "failed" | "gate-inconclusive" | "dropped" | "prose-inconclusive";
export type Residue = {
  label: string;
  reason: string;
  source: string;
  kind: ResidueKind;
  reasonClass: ResidueClass;
  /// 0-based indices into the emitted `## Workflow` list; set iff kind === "steps".
  /// The group id ("workflow:N") is group-numbered and pipeline-internal — these
  /// indices are the only mapping to the flat list a reviewer sees at apply time.
  stepIdxs?: number[];
};
// Did distill rewrite the body, or pass it through unchanged? The producer knows this at each
// return site (nothing-to-distill and expand-guard pass through; the normal path compresses);
// the routed build reads it to tag the footer rather than re-deriving it by byte-comparison.
// main() also maps a top-level "passthrough" to exit 3 (exit 3 ⇔ prefer the source); a routed
// note stays "compressed" even with a verbatim head (see distillRouted, below).
type DistillStatus = "compressed" | "passthrough";
// workflowByOwner is set only on a routed head's compressed return (owned is passed): the
// orderedSteps' rendered strings, bucketed by originating re-author section (groupStepsByOwner),
// so assembleRoutedNote can splice each owner's steps back at its section's position instead of
// the flat "## Workflow" this same run still carries inline in the gated/shared `out` below.
type DistillResult = {
  out: string;
  footer: string;
  residue: Residue[];
  status: DistillStatus;
  workflowByOwner?: string[][];
};
// one workflow group: steps sharing a source block-set, judged together by the
// workflow gate. `idxs` index into the ordered workflowSteps array.
type StepGroup = { id: string; idxs: number[]; sourceText: string };

// distill runs as a fixed sequence of stages, each a named function below: extract
// → order → synthesize → revise → gate → prose-QA → assemble. The stages share the
// segmented blocks and the entry/step ordering; defByTerm and workflowSteps are the
// two mutable carriers the synth/revise/gate stages refine in place. The orchestrator
// (distill) holds that state and threads it; each stage is independently importable
// so its slice can be exercised on its own (the pure ones — orderContent,
// computeStepGroups, buildFooter — without a model call).

// The whole-note (and, via the routed head's recursive call, per-head-scoped) expand-guard's
// threshold, customizable via --max-words: unset defaults to the note's own input size
// (today's behavior — any growth at all reverts to the original); a positive value sets an
// absolute ceiling instead; 0 disables the guard entirely, returning null (a debugging escape
// hatch to inspect what the model actually produced even when it grew).
export function expandGuardCap(beforeWords: number, maxWords?: number): number | null {
  if (maxWords === 0) return null;
  if (maxWords !== undefined && maxWords > 0) return maxWords;
  return beforeWords;
}

// stage 2: grade + order (pure). Given the extracted Combo, the segmented blocks, and
// their per-block grades, pick the retained-verbatim blocks and put the glossary
// entries and workflow steps in the note's own order (first appearance of their
// lowest source block, Array.sort stable across a shared block). A step whose every
// source block is retained verbatim is already carried by that block — drop it so
// the directive is not duplicated as both a fence and a step. Deterministic.
export function orderContent(
  combo: Combo,
  blocks: Block[],
  grades: Map<string, Grade>,
): {
  payloadBlocks: Block[];
  payloadBlockIds: Set<string>;
  orderedEntries: GlossEntry[];
  orderedSteps: WorkStep[];
} {
  const blockIndex = new Map(blocks.map((b, i) => [b.id, i]));
  const payloadBlocks = blocks.filter((b) => grades.get(b.id) === "retain");
  const payloadBlockIds = new Set(payloadBlocks.map((b) => b.id));
  const orderKey = (e: { source: string[] }) =>
    Math.min(...e.source.map((id) => blockIndex.get(id) ?? 1e9));
  const orderedEntries = [...combo.glossary].sort((a, b) => orderKey(a) - orderKey(b));
  const orderedSteps = combo.workflow
    .filter((s) => !s.source.every((id) => payloadBlockIds.has(id)))
    .sort((a, b) => orderKey(a) - orderKey(b));
  return { payloadBlocks, payloadBlockIds, orderedEntries, orderedSteps };
}

// Owner-tagged blocks for the routed head (D12/D16, WorkStep-splice build): segments each
// re-author RoutedSection's text INDEPENDENTLY, then reassigns sequential B-ids across the
// whole set — the same id scheme a single segment(reauthorText) call produces today, since
// segment() (text.ts:58-88) flushes at every fence-aware blank line and always flushes at
// end-of-input, and distillRouted's own "\n\n" join already forces a blank-line boundary at
// every section seam. The owner index lives in a side-map, not the id string, so the
// extraction prompt's literal "[Bn]" markers (prompts.ts) are byte-identical to today — this
// is what lets a WorkStep's existing `source: string[]` (block ids) be traced back to the
// section it came from without perturbing extraction.
export type OwnedBlocks = {
  blocks: Block[];
  owner: Map<string, number>;
  ownerCount: number;
};

export function tagOwnedBlocks(reauthorSections: { text: string }[]): OwnedBlocks {
  const blocks: Block[] = [];
  const owner = new Map<string, number>();
  let n = 0;
  reauthorSections.forEach((sec, idx) => {
    for (const b of segment(sec.text)) {
      n++;
      blocks.push({ id: `B${n}`, text: b.text });
      owner.set(`B${n}`, idx);
    }
  });
  return { blocks, owner, ownerCount: reauthorSections.length };
}

// Which re-author section a step traces back to: the earliest owner among its source block
// ids, mirroring orderContent's own Math.min tie-break (:126). A step whose source spans two
// owners (possible — extraction runs over the whole concatenated reauthorText as one blob)
// resolves to the earlier section, matching the note's own reading order.
function ownerOfStep(step: WorkStep, owner: Map<string, number>): number {
  let best: number | undefined;
  for (const id of step.source) {
    const o = owner.get(id);
    if (o !== undefined && (best === undefined || o < best)) best = o;
  }
  return best ?? 0; // unreachable in practice: orderContent already drops all-payload-sourced steps
}

// Bucket the already-ordered, already-synthesized workflowSteps strings by owning section
// (parallel array to orderedSteps), so the routed build can splice each owner's steps back at
// its section's position instead of bundling every step into the one head block.
export function groupStepsByOwner(
  orderedSteps: WorkStep[],
  workflowSteps: string[],
  owned: OwnedBlocks,
): string[][] {
  const byOwner: string[][] = Array.from({ length: owned.ownerCount }, () => []);
  orderedSteps.forEach((s, i) => byOwner[ownerOfStep(s, owned.owner)].push(workflowSteps[i]));
  return byOwner;
}

// group steps by their shared source block-set (pure) so the workflow gate judges
// them the way they exist: a practices/procedure list (one block) is one group whose
// steps are judged as a set against that block; steps in distinct blocks each form
// their own group, giving per-step granularity where the note allows it.
export function computeStepGroups(
  orderedSteps: WorkStep[],
  blockById: Map<string, Block>,
): StepGroup[] {
  const by = new Map<string, number[]>();
  orderedSteps.forEach((s, i) => {
    const sig = [...new Set(s.source)].sort().join("|");
    const g = by.get(sig);
    if (g) g.push(i);
    else by.set(sig, [i]);
  });
  return [...by.entries()].map(([sig, idxs], n) => ({
    id: `workflow:${n + 1}`,
    idxs,
    sourceText: sourceTextFor({ source: sig.split("|") }, blockById),
  }));
}

// stage 3: synthesize the distilled prose — glossary definitions via the dial, the
// short tie-together (the gate's thesis anchor, and the head in --glossary), and
// the per-step workflow. These three are independent, so they run concurrently; the
// connective prose body needs the defs, so it follows (skipped in --glossary).
async function synthesize(
  combo: Combo,
  orderedEntries: GlossEntry[],
  orderedSteps: WorkStep[],
  opts: { glossaryOnly: boolean },
  blockById: Map<string, Block>,
  lang: "en" | "ru",
): Promise<{
  defByTerm: Map<string, string>;
  tie: string;
  workflowSteps: string[];
  prose: string;
}> {
  const [defByTerm, tie, workflowSteps] = await Promise.all([
    synthEntries(orderedEntries, blockById, lang),
    tieTogether(combo, lang),
    synthWorkflow(orderedSteps, blockById, lang),
  ]);
  const prose = opts.glossaryOnly
    ? ""
    : await connectiveProse(combo, orderedEntries, defByTerm, lang);
  return { defByTerm, tie, workflowSteps, prose };
}

// stage 4: revise the distilled prose (tie + connective prose + each def + each
// step) through the writing passes, structure untouched. The bolded glossary terms
// are frozen so revise keeps each term's text (and bold) verbatim — the prose bolds
// them as glossary cross-references. Definitions are revised in place on defByTerm;
// the tie, prose, and workflow steps are returned.
async function reviseDistilled(
  tie: string,
  prose: string,
  orderedEntries: GlossEntry[],
  defByTerm: Map<string, string>,
  workflowSteps: string[],
  lang: "en" | "ru",
  onPass?: (index: number, total: number) => void,
): Promise<{ tie: string; prose: string; workflowSteps: string[] }> {
  const passes = lang === "ru" ? PASS_RU : PASS_EN;
  const dblocks: Block[] = [
    { id: "__TIE__", text: tie },
    ...(prose ? [{ id: "__PROSE__", text: prose }] : []),
    ...orderedEntries.map((e, i) => ({
      id: `__G${i}__`,
      text: defByTerm.get(e.term) ?? e.def,
    })),
    ...workflowSteps.map((s, i) => ({ id: `__W${i}__`, text: s })),
  ];
  const termLiterals = orderedEntries.map((e) => `**${e.term}**`);
  const rev = await revise(dblocks, passes, termLiterals, onPass);
  const byId = new Map(rev.map((b) => [b.id, b.text]));
  const revisedTie = byId.get("__TIE__") ?? tie;
  const revisedProse = prose ? (byId.get("__PROSE__") ?? prose) : prose;
  orderedEntries.forEach((e, i) => {
    const t = byId.get(`__G${i}__`);
    if (t) defByTerm.set(e.term, t);
  });
  const revisedSteps = workflowSteps.map((s, i) => byId.get(`__W${i}__`) ?? s);
  return { tie: revisedTie, prose: revisedProse, workflowSteps: revisedSteps };
}

// stage 5: fidelity gate + recovery. Two criteria, two gates, one shared retry loop:
// concepts round-trip bidirectionally against source (a def must capture the whole
// concept); workflow groups are judged for directive coverage only (a checklist may
// drop rationale). Both re-render failing items from source, capped at maxRetries; a
// workflow group the ladder cannot clear ships the source's own verbatim imperative.
// Surviving residue (incl. an unrecoverable thesis) and gate-inconclusive items are
// surfaced, never silent. The gate certifies the GLOSSARY form (tie + definitions),
// never the prose. Definitions and steps are repaired in place (defByTerm,
// workflowSteps); the metrics + residue are returned.
async function runFidelityGate(
  combo: Combo,
  h1: string,
  tie: string,
  orderedEntries: GlossEntry[],
  orderedSteps: WorkStep[],
  defByTerm: Map<string, string>,
  workflowSteps: string[],
  payloadBlocks: Block[],
  blockById: Map<string, Block>,
  lang: "en" | "ru",
  opts: { maxRetries: number; isReference: boolean },
): Promise<{
  residue: Residue[];
  retries: number;
  gateSkipped: number;
  keptVerbatim: number;
}> {
  const stepGroups = computeStepGroups(orderedSteps, blockById);
  let gloss = assembleBody(
    h1,
    tie,
    workflowSteps,
    orderedEntries,
    defByTerm,
    payloadBlocks,
    opts.isReference,
  );

  const residue: Residue[] = [];
  let retries = 0;
  let gateSkipped = 0;
  let keptVerbatim = 0;
  const renderedC = () =>
    orderedEntries.map((e) => ({
      term: e.term,
      def: defByTerm.get(e.term) ?? e.def,
      sourceText: sourceTextFor(e, blockById),
    }));
  const renderedG = () =>
    stepGroups.map((g) => ({
      id: g.id,
      steps: g.idxs.map((i) => workflowSteps[i]),
      sourceText: g.sourceText,
    }));
  const [graded, gradedG] = await Promise.all([
    fidelityGate(combo.thesis, gloss, renderedC()),
    workflowGate(renderedG(), lang),
  ]);
  const thesisRecoverable = graded.thesisRecoverable;
  // inconclusive verdicts (judge returned no JSON) are set aside from the start:
  // recovery cannot fix them, so they bypass the retry loop and surface directly.
  const inconclusiveC = new Map<string, ConceptVerdict>();
  const inconclusiveG = new Map<string, StepVerdict>();
  for (const c of graded.concepts) if (c.grade === "inconclusive") inconclusiveC.set(c.term, c);
  for (const g of gradedG) if (g.grade === "inconclusive") inconclusiveG.set(g.id, g);
  let failC = graded.concepts.filter((c) => c.grade === "residue");
  let failG = gradedG.filter((g) => g.grade === "residue");
  while ((failC.length > 0 || failG.length > 0) && retries < opts.maxRetries) {
    retries++;
    // re-render failing concepts/groups from source, regardless of dial; items are
    // independent, so concurrent. Recovery bypasses revise(), so normalize here.
    await Promise.all([
      ...failC.map(async (c) => {
        const entry = orderedEntries.find((e) => e.term === c.term);
        if (!entry) return;
        try {
          const r = await askJson<{ def: string }>(
            EXTRACT,
            renderEntryPrompt(entry, sourceTextFor(entry, blockById), lang),
            1024,
          );
          if (r.def) defByTerm.set(entry.term, normalizeTypography(r.def.trim()));
        } catch (e) {
          rethrowIfBug(e, "recover-def");
          // a transient re-render flake keeps the prior def; the gate re-grades it next
        }
      }),
      ...failG.map(async (v) => {
        const g = stepGroups.find((x) => x.id === v.id);
        if (!g) return;
        try {
          if (WF_RECOVERY === "retighten") {
            // re-tighten the whole group from source (drafts individuate the steps).
            // Same compression pressure that inverted the step — kept for the experiment.
            const tightened = await synthWorkflow(
              g.idxs.map((i) => orderedSteps[i]),
              blockById,
              lang,
            );
            g.idxs.forEach((i, k) => {
              if (tightened[k]) workflowSteps[i] = normalizeTypography(tightened[k]);
            });
          } else {
            // judge-guided repair: feed the gate's finding back so the rewrite fixes
            // the named inversion instead of re-running the compression that caused it
            const repaired = await repairWorkflowGroup(
              g.idxs.map((i) => workflowSteps[i]),
              v.missing,
              g.sourceText,
              lang,
            );
            g.idxs.forEach((i, k) => {
              if (repaired[k]) workflowSteps[i] = normalizeTypography(repaired[k]);
            });
          }
        } catch (e) {
          rethrowIfBug(e, "recover-steps");
          // a transient re-render flake keeps the prior steps; the gate re-grades them next
        }
      }),
    ]);
    gloss = assembleBody(
      h1,
      tie,
      workflowSteps,
      orderedEntries,
      defByTerm,
      payloadBlocks,
      opts.isReference,
    );
    // re-grade only the patched items, not the full set (budget)
    const patchC = new Set(failC.map((c) => c.term));
    const patchG = new Set(failG.map((g) => g.id));
    const [reg, regG] = await Promise.all([
      patchC.size
        ? fidelityGate(
            combo.thesis,
            gloss,
            renderedC().filter((r) => patchC.has(r.term)),
          )
        : Promise.resolve({
            thesisRecoverable,
            concepts: [] as ConceptVerdict[],
          }),
      patchG.size
        ? workflowGate(
            renderedG().filter((r) => patchG.has(r.id)),
            lang,
          )
        : Promise.resolve([] as StepVerdict[]),
    ]);
    // a re-grade can itself come back inconclusive — capture those too, then drop
    // them from the recoverable sets so the loop never retries an unparseable verdict.
    for (const c of reg.concepts) if (c.grade === "inconclusive") inconclusiveC.set(c.term, c);
    for (const g of regG) if (g.grade === "inconclusive") inconclusiveG.set(g.id, g);
    failC = reg.concepts.filter((c) => c.grade === "residue");
    failG = regG.filter((g) => g.grade === "residue");
  }
  // verbatim fallback: a workflow group the repair ladder could not clear ships
  // the source's own imperative verbatim. The clause is a literal substring of
  // source, so it covers the action and cannot invert — the inversion clears at
  // the cost of a slightly verbose step, which beats shipping it inverted. Groups
  // whose source yields no extractable clause stay in failG and surface as residue.
  if (WF_RECOVERY === "repair-verbatim" && failG.length) {
    const stillFail: StepVerdict[] = [];
    for (const v of failG) {
      const g = stepGroups.find((x) => x.id === v.id);
      const verb = g ? verbatimDirectives(g.sourceText) : [];
      if (g && verb.length) {
        g.idxs.forEach((idx, k) => {
          // pair clauses to slots in order; the last slot absorbs any overflow,
          // surplus slots blank out (filtered when the Workflow list renders).
          workflowSteps[idx] =
            k < verb.length
              ? k === g.idxs.length - 1 && verb.length > g.idxs.length
                ? verb.slice(k).join("; ")
                : verb[k]
              : "";
        });
        keptVerbatim++;
      } else {
        stillFail.push(v);
      }
    }
    failG = stillFail;
    if (keptVerbatim) {
      gloss = assembleBody(
        h1,
        tie,
        workflowSteps,
        orderedEntries,
        defByTerm,
        payloadBlocks,
        opts.isReference,
      );
    }
  }
  // surviving residue (incl. an unrecoverable thesis) is surfaced, never silent
  for (const c of failC) {
    const entry = orderedEntries.find((e) => e.term === c.term);
    residue.push({
      label: c.term,
      reason: `${c.direction || "residue"}: ${c.missing || "failed round-trip entailment"}`,
      source: entry ? sourceTextFor(entry, blockById) : "",
      kind: "def",
      reasonClass: "failed",
    });
  }
  for (const v of failG) {
    const g = stepGroups.find((x) => x.id === v.id);
    residue.push({
      label: v.id,
      reason: `workflow: ${v.missing || "directive coverage failed"}`,
      source: g ? g.sourceText : "",
      kind: "steps",
      reasonClass: "failed",
      stepIdxs: g ? g.idxs : [],
    });
  }
  if (!thesisRecoverable) {
    residue.unshift({
      label: "(thesis)",
      reason: "thesis not recoverable from output",
      source: combo.thesis,
      kind: "thesis",
      reasonClass: "failed",
    });
  }
  // gate-inconclusive items: the judge could not render a verdict (no JSON after
  // retry). Ship them surfaced-but-unverified, distinct from genuine residue, so a
  // judge flake never discards the run — the floor under the passthrough failsafe.
  for (const c of inconclusiveC.values()) {
    const entry = orderedEntries.find((e) => e.term === c.term);
    residue.push({
      label: c.term,
      reason: `gate-inconclusive: ${c.missing || "judge returned no verdict"}`,
      source: entry ? sourceTextFor(entry, blockById) : "",
      kind: "def",
      reasonClass: "gate-inconclusive",
    });
  }
  for (const v of inconclusiveG.values()) {
    const g = stepGroups.find((x) => x.id === v.id);
    residue.push({
      label: v.id,
      reason: `gate-inconclusive: ${v.missing || "judge returned no verdict"}`,
      source: g ? g.sourceText : "",
      kind: "steps",
      reasonClass: "gate-inconclusive",
      stepIdxs: g ? g.idxs : [],
    });
  }
  gateSkipped = inconclusiveC.size + inconclusiveG.size;
  return { residue, retries, gateSkipped, keptVerbatim };
}

// prose QA: judge the un-gated readable head against its own contract and repair
// best-effort. One judge + one fix pass — defects never block, so no re-judge.
// Sits BELOW the fidelity line; the caller rides it on the --no-gate switch and
// skips it in --glossary (no prose).
async function runProseQA(
  thesis: string,
  prose: string,
  lang: "en" | "ru",
): Promise<{ prose: string; proseFixes: number }> {
  const pj = await proseJudge(thesis, prose);
  if (!pj.pass && pj.issues.length) {
    return {
      prose: await proseFix(prose, pj.issues, lang),
      proseFixes: pj.issues.length,
    };
  }
  return { prose, proseFixes: 0 };
}

// build the success footer line — the one-line summary stderr carries beside the
// temp-file path on stdout. Pure; the nothing-to-distill and expansion guards in distill()
// emit their own footers, so this only renders a real (compressed-or-equal) run.
export function buildFooter(m: {
  beforeWords: number;
  afterWords: number;
  entries: number;
  steps: number;
  verbatim: number;
  residue: number;
  gateSkipped: number;
  keptVerbatim: number;
  retries: number;
  proseFixes: number;
  glossaryOnly: boolean;
  proseGateOffFactsDump: boolean;
  nameLint?: NameLintResult;
}): string {
  const pct = m.beforeWords
    ? Math.round((100 * (m.beforeWords - m.afterWords)) / m.beforeWords)
    : 0;
  const sizeTag = `${pct > 0 ? "-" : pct < 0 ? "+" : "±"}${Math.abs(pct)}%`; // expansion is guarded in distill(), so this is -N% or ±0%
  const retriesTag = m.retries ? ` · ${m.retries} retries` : "";
  const proseTag = m.proseFixes ? ` · ${m.proseFixes} prose fixes` : "";
  const stepsTag = m.steps ? ` · ${m.steps} steps` : "";
  // gate-skipped items are a subset of residue.length — flag them so a batch log
  // distinguishes "judge couldn't verify" from a genuine fidelity miss.
  const gateTag = m.gateSkipped ? ` · ${m.gateSkipped} gate-skipped` : "";
  // steps the repair ladder could not clear and that shipped the source's verbatim
  // imperative — faithful but uncompressed, distinct from a cleared step
  const verbatimTag = m.keptVerbatim ? ` · ${m.keptVerbatim} kept-verbatim` : "";
  const shapeTag = m.glossaryOnly ? "gloss" : "prose+gloss";
  // the prose gate would have run (!noGate && !glossaryOnly) but the facts-dump genre gate
  // skipped it — surface the skip so disabling a loss detector is never silent.
  const proseGateTag = m.proseGateOffFactsDump ? ` · prose-gate off (facts-dump)` : "";
  return `— distilled ${shapeTag} · ${m.beforeWords}→${m.afterWords} words (${sizeTag}) · ${m.entries} entries${stepsTag} · ${m.verbatim} verbatim · ${m.residue} residue${gateTag}${verbatimTag}${retriesTag}${proseTag}${proseGateTag}${m.nameLint ? formatNameLint(m.nameLint) : ""}`;
}

// edge-coverage gate (deterministic, pure). A vault edge — a [[wikilink]] or a
// scheme-less [text](path) markdown link — is a deliberate cross-note relation, but the
// fidelity gate grades only concept defs + workflow coverage — never edges. So an
// extractor that fails to encode a source link as a relation, plus the prose-fold that
// dissolves the inline link, drops the edge with ZERO residue. This diffs the source
// edge set (harvestVaultEdges) against the final output's; every source target absent
// from output surfaces as residue — flipping the loss from silent to loud on a one-way
// door (distilled output overwrites the non-git-tracked source). A link covered ANYWHERE
// in output — a retained see-also list, the `## Relations` block, or the prose — is not
// residue. Both source and covered sets run through harvestVaultEdges, so an output
// markdown link covers a source wikilink to the same note and vice versa.
// Both harvest lanes route through normalizeEdgeTarget, which strips a trailing
// `#fragment` before slugging, so a fragment-bearing source edge (`[[note#heading]]`)
// slugs to `note` and is covered by an output `[[note]]` — no anchor-downgrade false
// positive. emitRelationsBlock's `[[file-slug]]` endpoints carry no fragment, so the
// REBUILD round-trip is byte-stable through the change.
// This narrows the guarantee to note→note edges, NOT anchor precision: several
// distinct-anchor links to ONE note (`[[note#a]]` + `[[note#b]]`) collapse to slug
// `note`, so dropping one anchor while any link to `note` survives reads as covered,
// not residue. Section-anchor loss is outside the net by design (the vault is
// navigational; no note's meaning depends on which anchor survives, audited 2026-06-29).
export function wikilinkResidue(sourceText: string, outputText: string): Residue[] {
  const covered = new Set(harvestVaultEdges(outputText).map((w) => w.slug));
  // Group source edges by slug, tracking the DISTINCT normalized targets and the
  // first-appearance markups under each. The discriminator is the distinct target
  // (target.trim().toLowerCase()), NOT the distinct markup: alias/bare/case-only
  // spellings of ONE target ([[foo]] + [[foo|a]] + [[Foo]], or [[foo]] + [foo](foo.md))
  // collapse to a single distinct target and run the normal covered/dropped logic; only
  // two genuinely different targets that slug alike (e.g. [[foo bar]] and [[foo/bar]])
  // are a real collision, where output's single endpoint cannot be attributed to one.
  // Map preserves first-insertion order over its keys, so it carries the slug order itself.
  const bySlug = new Map<string, { markups: string[]; targets: Set<string> }>();
  for (const { markup, slug, target } of harvestVaultEdges(sourceText)) {
    let g = bySlug.get(slug);
    if (!g) {
      g = { markups: [], targets: new Set() };
      bySlug.set(slug, g);
    }
    if (!g.markups.includes(markup)) g.markups.push(markup); // dedup exact markups, keep order
    g.targets.add(target.trim().toLowerCase());
  }
  const residue: Residue[] = [];
  for (const [slug, g] of bySlug) {
    // collision: >1 distinct target shares the slug, so coverage is ambiguous — don't
    // trust it. Surface every colliding markup as residue even when the slug is covered:
    // a loud false positive the curator dismisses, not a silent drop on a one-way write.
    if (g.targets.size > 1) {
      for (const markup of g.markups) {
        residue.push({
          label: markup,
          reason:
            "wikilink slug-collision: distinct source edges share a slug; output coverage is ambiguous — verify each manually",
          source: markup,
          kind: "edge",
          reasonClass: "dropped",
        });
      }
      continue;
    }
    if (covered.has(slug)) continue;
    const markup = g.markups[0];
    residue.push({
      label: markup,
      reason: "wikilink dropped: source edge absent from output (no relation, no retained block)",
      source: markup,
      kind: "edge",
      reasonClass: "dropped",
    });
  }
  return residue;
}

// payloadResidue — the prose-payload analogue of wikilinkResidue. Catches dropped NON-edge,
// NON-prose payload the distiller is not licensed to compress: verbatim fenced blocks,
// verbatim blockquotes, table data rows, image/asset embeds, math/formulas, external
// citations, and substantive statistics (the seven text.ts harvesters). The principal
// contradiction — catch real loss WITHOUT false-flagging prose the tool is entitled to
// compress — is resolved by EXCLUSION at harvest, not by scoring: only literal/structural
// classes enter the inventory, so a restatement-collapse yields zero residue by
// construction (no model consulted, the strongest form of "don't trust the model that
// caused the loss"). Per lane: build the covered key-set by running the SAME harvester over
// the final `out` (a span surviving ANYWHERE in output — prose, a glossary cell, a retained
// block — is covered), dedup source keys, surface each uncovered key once. No slug-collision
// branch (unlike wikilinkResidue): the key is a content signature, not a lossy slug, so two
// source spans sharing a key ARE the same payload. Deterministic and free, so it runs even
// under --no-gate. Known residual: a pure-prose dropped sub-section / worked example /
// qualifier carries no harvestable token and stays silent here — that is the deferred judge
// tier's job, gated on eval evidence, not this deterministic spine's.
const PAYLOAD_LANES: {
  harvest: (t: string) => PayloadSpan[];
  reason: string;
}[] = [
  {
    harvest: harvestFences,
    reason: "fenced-block dropped: verbatim code/output block absent from output (not retained)",
  },
  {
    harvest: harvestBlockquotes,
    reason: "blockquote dropped: verbatim quotation absent from output (reworded or cut)",
  },
  {
    harvest: harvestTableRows,
    reason: "table-row dropped: data row absent from output (structure dissolved into prose)",
  },
  {
    harvest: harvestImages,
    reason: "image-embed dropped: image/asset cannot be recovered from prose",
  },
  {
    harvest: harvestMath,
    reason: "math dropped: formula absent from output (not recoverable from prose)",
  },
  {
    harvest: harvestCitations,
    reason: "citation-url dropped: external source link absent from output",
  },
  {
    harvest: harvestNumbers,
    reason:
      "numeric-token dropped: source statistic absent from output (figure lost in re-authoring)",
  },
];
export function payloadResidue(sourceText: string, outputText: string): Residue[] {
  const residue: Residue[] = [];
  for (const lane of PAYLOAD_LANES) {
    const covered = new Set(lane.harvest(outputText).map((s) => s.key));
    const seen = new Set<string>();
    for (const s of lane.harvest(sourceText)) {
      if (covered.has(s.key) || seen.has(s.key)) continue;
      seen.add(s.key);
      residue.push({
        label: s.markup,
        source: s.markup,
        reason: lane.reason,
        kind: "payload",
        reasonClass: "dropped",
      });
    }
  }
  return residue;
}

// The single origin of a build's deterministic edge+payload residue: dropped [[wikilink]] edges
// (wikilinkResidue) and dropped payload spans (payloadResidue), surfaced for rollback (D16). Both
// distill (homogeneous build) and assembleRoutedNote (the routed whole-note run) call THIS, so the
// pair is never duplicated and the routed-skip rule lives in one tested place. A routed head
// (routed=true) contributes nothing: assembleRoutedNote owns the whole-note run, so a head running
// these gates over its own narrower subset would false-flag a link alive in a preserve section and
// double-count a real drop. Returning [] for the routed head IS the residue-scope fix, and it is
// the invariant assembleRoutedNote relies on when it concats head.residue.
export function edgePayloadResidue(text: string, out: string, routed = false): Residue[] {
  return routed ? [] : [...wikilinkResidue(text, out), ...payloadResidue(text, out)];
}

// ---- prose-list-item gate (the prose-judge tier, D46) ----
// The deterministic spine above catches dropped literal/structural payload; this gate catches
// a dropped pure-prose list-item, the must-cover class the spine AND the fidelity/workflow
// gates are all blind to. text.ts::harvestProseListItems is the deterministic answer key;
// prompts.ts::proseGate (glm, the model that did not write the compression) is the matcher;
// the covered→clear decision is made HERE — surfaced is the DEFAULT for every outcome except
// an explicit covered verdict whose anchor is verified present and on-topic.

// EN+RU stoplist: function words the anchor-relevance test must not count as a shared content
// word (else a "the of and" overlap could clear an off-topic anchor). Over-inclusion here is
// safe — it raises the bar to clear, surfacing more (loud), never clearing more (silent).
const STOPWORDS = new Set(
  (
    "the a an of to in on at for and or but is are was were be been being it its this that these those with as by from not no " +
    "и в во не на он его но что а то все так да ты к у же вы за бы по только ее мне было вот от меня для о из ему при до или это " +
    "как мы их кто чтобы бы ли если"
  ).split(/\s+/),
);
const contentWords = (s: string): string[] =>
  normalizeForContainment(s)
    .split(" ")
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));

// A "covered" verdict clears a unit only when its quoted anchor (i) is a real ≥16-char
// substring of the output AND (ii) shares ≥2 content words with the item it claims to cover.
// (ii) is the load-bearing fix: existence alone let glm launder a dropped item by quoting
// unrelated true output text (e.g. the thesis); requiring shared content words binds the
// anchor to the JUDGED item, so the model cannot point at the thesis to clear a dropped caveat.
export function anchored(v: ProseVerdict, span: string, normOut: string): boolean {
  const a = normalizeForContainment(v.anchor ?? "");
  if (a.length < 16 || !normOut.includes(a)) return false;
  const aw = new Set(contentWords(a));
  return contentWords(span).filter((w) => aw.has(w)).length >= 2;
}

// Pure mapping: inventory units + the matcher's verdicts → residue. A unit clears to zero
// residue ONLY on an explicit covered verdict whose anchor is verified present and on-topic
// (anchored). An omitted id, an unanchored covered, a non-covered grade, or a flaked batch all
// surface — the model that caused the loss never clears a span by silence or a vague anchor.
export function proseResidue(
  units: ProseUnit[],
  verdicts: Map<string, ProseVerdict>,
  flaked: Set<string>,
  outputText: string,
): Residue[] {
  const normOut = normalizeForContainment(outputText);
  const residue: Residue[] = [];
  for (const u of units) {
    const v = verdicts.get(u.id);
    if (!v) {
      residue.push({
        label: u.id,
        source: u.span,
        reason: flaked.has(u.id)
          ? "prose-inconclusive: judge returned no verdict for this item's batch"
          : "prose-inconclusive: judge omitted this item from its verdict",
        kind: "prose",
        reasonClass: "prose-inconclusive",
      });
      continue;
    }
    if (v.grade === "covered" && anchored(v, u.span, normOut)) continue; // the ONLY clear
    residue.push({
      label: u.id,
      source: u.span,
      reason:
        v.grade === "dropped"
          ? `prose dropped: ${v.missing || "list-item information absent from output"}`
          : "prose-inconclusive: covered verdict not anchored to a verifiable, on-topic output location",
      kind: "prose",
      reasonClass: v.grade === "dropped" ? "dropped" : "prose-inconclusive",
    });
  }
  return residue;
}

// orchestrate the gate: match the harvested inventory (glm, batched) and map to residue.
async function runProseGate(
  units: ProseUnit[],
  outputText: string,
  lang: "en" | "ru",
): Promise<Residue[]> {
  if (units.length === 0) return [];
  const { verdicts, flaked } = await proseGate(units, outputText, lang);
  return proseResidue(units, verdicts, flaked, outputText);
}

// orchestrator: thread the stages above, holding the shared state (segmented
// blocks, ordering, and the two mutable carriers defByTerm + workflowSteps). The
// output is identical to the pre-decomposition single function; the stages only
// name the seams.
async function distill(
  text: string,
  lang: "en" | "ru",
  frontDescription: string,
  opts: {
    maxRetries: number;
    noRevise: boolean;
    noGate: boolean;
    glossaryOnly: boolean;
    isReference: boolean;
    factsDump: boolean;
    tau: number;
    maxWords?: number;
    progress?: (line: string) => void;
  },
  selfSlug = "",
  routed = false,
  owned?: OwnedBlocks,
): Promise<DistillResult> {
  // Per-section render-router (D12/D16, Backlog 10). When a note carries any payload-dense
  // section, route: re-author the idea sections into ONE compact head (recurse — the head is
  // itself a homogeneous distill, which gives the expand guard scoped to its own source), hold
  // the payload sections verbatim (compactSection v1), reassemble in source order into one
  // note. `routed` guards the one-level recursion: the head re-enters with routing skipped.
  if (!routed && !opts.glossaryOnly) {
    const { title, sections } = partition(text, opts.tau);
    if (sections.some((u) => u.route === "preserve")) {
      return distillRouted(text, title, sections, lang, frontDescription, opts, selfSlug);
    }
  }
  const blocks = owned?.blocks ?? segment(text);
  const blockById = new Map(blocks.map((b) => [b.id, b]));
  const beforeWords = wordCount(text);

  // The note's own slug — the source endpoint of a note-level edge (D38) and the SELF
  // anchor the extractor classifies links against. Prefer the filename slug (what other
  // vault notes wikilink to); fall back to the H1 title slug when reading from stdin (no
  // filename). Computed before extract so prompt and emit use one consistent slug.
  const h1 = blocks.find((b) => /^#\s/.test(b.text))?.text.split("\n")[0] ?? "";
  const effectiveSelfSlug = selfSlug || slugSegment(h1.replace(/^#+\s*/, ""));

  // 1. extract the idea-graph; nothing to distill (no concepts, no directives) →
  // passthrough, footer notes it. The deterministic link inventory (every vault edge —
  // [[wikilink]] or scheme-less [text](path) — UNION every external [text](url)) is fed
  // to the extractor as a MUST-COVER checklist.
  const linkInventory: LinkInventory = {
    wikilinks: harvestVaultEdges(text),
    external: harvestExternalLinks(text),
  };
  opts.progress?.("extract…");
  const combo = await extractCombo(
    blocks,
    frontDescription,
    lang,
    linkInventory,
    effectiveSelfSlug,
  );
  if (combo.glossary.length === 0 && combo.workflow.length === 0) {
    return {
      out: text,
      footer: `— nothing to distill · ${beforeWords} words`,
      residue: [],
      status: "passthrough",
    };
  }

  // 2. grade blocks, then order entries/steps (pure)
  opts.progress?.("grade…");
  const grades = await gradeBlocks(combo, blocks);
  const { payloadBlocks, orderedEntries, orderedSteps } = orderContent(combo, blocks, grades);

  // 3. synthesize defs + tie + workflow + connective prose body
  opts.progress?.("synthesize…");
  const synth = await synthesize(combo, orderedEntries, orderedSteps, opts, blockById, lang);
  const defByTerm = synth.defByTerm;
  let tie = synth.tie;
  let workflowSteps = synth.workflowSteps;
  let prose = synth.prose;

  // 4. revise the distilled prose (structure untouched), defs revised in place
  if (!opts.noRevise) {
    const revised = await reviseDistilled(
      tie,
      prose,
      orderedEntries,
      defByTerm,
      workflowSteps,
      lang,
      (i, n) => opts.progress?.(`revise ${i}/${n}`),
    );
    tie = revised.tie;
    prose = revised.prose;
    workflowSteps = revised.workflowSteps;
  }

  // 5. fidelity gate + recovery (defs/steps repaired in place; --no-gate skips it)
  let residue: Residue[] = [];
  let retries = 0;
  let gateSkipped = 0;
  let keptVerbatim = 0;
  if (!opts.noGate) {
    opts.progress?.("gate…");
    ({ residue, retries, gateSkipped, keptVerbatim } = await runFidelityGate(
      combo,
      h1,
      tie,
      orderedEntries,
      orderedSteps,
      defByTerm,
      workflowSteps,
      payloadBlocks,
      blockById,
      lang,
      { maxRetries: opts.maxRetries, isReference: opts.isReference },
    ));
  }

  // prose QA: judge the un-gated readable head and repair best-effort. Rides the
  // --no-gate switch; no-op in --glossary (no prose).
  let proseFixes = 0;
  if (prose && !opts.noGate) {
    opts.progress?.("prose-qa…");
    const qa = await runProseQA(combo.thesis, prose, lang);
    prose = qa.prose;
    proseFixes = qa.proseFixes;
  }

  // assemble the final output: the connective prose head by default, the tie in
  // --glossary. Definitions are the gate-settled ones; the prose restates none
  // of them, so recovery changing a def never invalidates the prose above it.
  const out = assembleBody(
    h1,
    opts.glossaryOnly ? tie : prose,
    workflowSteps,
    orderedEntries,
    defByTerm,
    payloadBlocks,
    opts.isReference,
  );

  const afterWords = wordCount(out);
  // passthrough guard: a distillation that expands the note has failed its one job.
  // Ship the original body rather than the larger output. (the footer's +N% only
  // flagged this after the fact; this prevents it.) Customizable via --max-words: null
  // (--max-words 0) disables the guard entirely — a debugging escape hatch to inspect what
  // the model actually produced even when it grew, without risking a worse note shipping by
  // default (the flag must be passed explicitly every time; there is no sticky/silent bypass).
  const cap = expandGuardCap(beforeWords, opts.maxWords);
  if (cap !== null && afterWords > cap) {
    return {
      out: text,
      footer: `— distillation expanded ${beforeWords}→${afterWords} words; kept original`,
      residue: [],
      status: "passthrough",
    };
  }
  // prose-list-item gate (D46): a glm matcher over a deterministic inventory of explicit
  // list-items under a heading — the must-cover prose class the spine is blind to and the
  // fidelity/workflow gates never see. An LLM call, so it rides --no-gate like runFidelityGate;
  // skipped in --glossary (no prose body to cover into) and on facts/context dumps (wholesale
  // drop is licensed there, so the inventory would only flood the footer). EXCLUSION-3 drops
  // items already folded into a graded def or step (sourceTextFor / StepGroup.sourceText), so
  // the matcher only judges list-items the existing gates do not. Appends to residue only.
  if (!opts.noGate && !opts.glossaryOnly && !opts.factsDump) {
    const claimed = [
      ...orderedEntries.map((e) => sourceTextFor(e, blockById)),
      ...computeStepGroups(orderedSteps, blockById).map((g) => g.sourceText),
    ];
    const units = harvestProseListItems(text, claimed);
    opts.progress?.("prose-gate…");
    residue = residue.concat(await runProseGate(units, out, lang));
  }

  // edge-coverage gate: surface any source [[wikilink]] or payload span the distilled output
  // dropped as residue. Deterministic and free, so it runs even under --no-gate — a dropped
  // cross-note edge is irreversible loss the fidelity gate never checks. `out` is the final body
  // (prose + ## Relations + retained), so a link surviving in any of them counts as covered. The
  // routed head passes routed=true and contributes nothing here (assembleRoutedNote owns the one
  // whole-note run); the routed-skip and its rationale live in edgePayloadResidue.
  residue = residue.concat(edgePayloadResidue(text, out, routed));
  // deterministic, zero-LLM, never blocks — findings go to the footer only, never
  // into residue. Skipped on the routed head (its subset lint would false-flag names
  // living only in preserve sections; assembleRoutedNote owns the whole-note run).
  const nameLint = routed ? undefined : nameLintAgainstSource(out, text);
  const footer = buildFooter({
    beforeWords,
    afterWords,
    entries: orderedEntries.length,
    steps: orderedSteps.length,
    verbatim: payloadBlocks.length,
    residue: residue.length,
    gateSkipped,
    keptVerbatim,
    retries,
    proseFixes,
    glossaryOnly: opts.glossaryOnly,
    // the prose gate is in scope (!noGate && !glossaryOnly) but the facts-dump genre gate
    // skipped it above — flag the disabled loss detector instead of dropping it silently.
    proseGateOffFactsDump: !opts.noGate && !opts.glossaryOnly && opts.factsDump,
    nameLint,
  });
  // Routed head only: derive the split view for assembleRoutedNote WITHOUT touching the
  // gated/shared `out` above — everything graded/guarded against it (the expand guard, the
  // prose-list-item gate, edgePayloadResidue, buildFooter) stays byte-identical to the
  // homogeneous build. This second, disposable render carries prose + Glossary + Relations
  // only (workflowSteps: [] skips assembleBody's own "## Workflow" emission); the steps
  // themselves are exposed separately, bucketed by owning section, for the caller to splice.
  let workflowByOwner: string[][] | undefined;
  let exposedOut = out;
  if (routed && owned) {
    workflowByOwner = groupStepsByOwner(orderedSteps, workflowSteps, owned);
    exposedOut = assembleBody(
      h1,
      opts.glossaryOnly ? tie : prose,
      [],
      orderedEntries,
      defByTerm,
      payloadBlocks,
      opts.isReference,
    );
  }
  return {
    out: exposedOut,
    footer,
    residue,
    status: "compressed",
    workflowByOwner,
  };
}

// The heterogeneous (per-section-routed) build (D12/D16, Backlog 10). Re-author the idea
// sections as one head — a homogeneous distill() of their concatenation, so the head carries
// its own thesis/glossary/workflow/relations and its own scoped expand guard — then hold the
// payload sections verbatim (compactSection v1) and reassemble in source order into one note.
// The deterministic edge/payload residue gates re-run over (whole source, reassembled out) so
// any dropped link or payload still surfaces (D16: surface-for-rollback). The whole-note
// expand guard is intentionally NOT applied here: the preserve sections are held verbatim and
// cannot shrink, so a whole-note size compare would no-op the route on its target class.
async function distillRouted(
  text: string,
  title: string,
  sections: RoutedSection[],
  lang: "en" | "ru",
  frontDescription: string,
  opts: Parameters<typeof distill>[3],
  selfSlug: string,
): Promise<DistillResult> {
  const reauthorSections = sections.filter((u) => u.route === "re-author");
  const reauthorText = reauthorSections
    .map((u) => u.text)
    .join("\n\n")
    .trim();
  const owned = tagOwnedBlocks(reauthorSections);
  const head = reauthorText
    ? await distill(reauthorText, lang, frontDescription, opts, selfSlug, true, owned)
    : {
        out: "",
        footer: "",
        residue: [] as Residue[],
        status: "passthrough" as const,
      };
  // The routed note is itself a compression (prose re-authored, payload compacted); its own
  // status is "compressed". Unconsumed today (the routed=true guard blocks nesting), but the
  // contract is honest and a constant, so it cannot drift.
  return {
    ...assembleRoutedNote({
      source: text,
      title,
      reauthorText,
      head,
      sections,
    }),
    status: "compressed",
  };
}

// Pure seam of the per-section routed build (the no-LLM tail of distillRouted): reassemble the
// routed note, splice the head's per-owner workflow steps back at their originating section's
// position, run the deterministic edge+payload gates ONCE at whole-note scope, and build the
// footer. No model and no I/O, so distillRouted's wiring is unit-testable in pure.test.ts. This is
// the whole-note edge/payload run the routed head defers to (the head passed routed=true to
// edgePayloadResidue and so contributed none), called here over (source, reassembled out): a link
// surviving in a preserve section reads as covered (no false drop) and a real drop counts once (no
// double-count). The verbatim-head tag surfaces a head the inner expand or nothing-to-distill guard
// returned unchanged, read from the head's own `status` (the producer is the authority); reauthorText
// !== "" excludes the empty-head / all-preserve route (a passthrough head with no prose) from tagging.
//
// Prose + Glossary + Relations stay ONE synthesized, head-first block exactly as before — only
// the "## Workflow" steps split out of that block (head.out no longer carries one; see distill's
// routed-return branch) and get spliced in at their owning section's position. Walking `sections`
// once accumulates steps across consecutive re-author owners into `pending`, flushing (rendering,
// numbering continuing from the running total) whenever a preserve section or the note's end is
// hit — this is what naturally coalesces adjacent re-author owners into a single fragment. Each
// rendered fragment is still plain "## Workflow" text pushed into reassembleNote's existing
// `preserves` array, so its own demote() sweep (text.ts) turns it into "### Workflow" exactly as
// it would a genuine preserve section's own colliding heading — no new heading logic needed.
export function assembleRoutedNote(a: {
  source: string;
  title: string;
  reauthorText: string;
  head: {
    out: string;
    residue: Residue[];
    status: DistillStatus;
    workflowByOwner?: string[][];
  };
  sections: { route: Route; text: string }[];
}): { out: string; footer: string; residue: Residue[] } {
  const beforeWords = wordCount(a.source);
  const chunks: string[] = [];
  let reauthorIdx = 0;
  let running = 0;
  let pending: string[] = [];
  const flush = () => {
    if (!pending.length) return;
    const { text, count } = renderWorkflowBlock(pending, running + 1);
    if (text) {
      chunks.push(text);
      running += count;
    }
    pending = [];
  };
  for (const u of a.sections) {
    if (u.route === "preserve") {
      flush();
      chunks.push(compactSection(u.text));
    } else {
      pending = pending.concat(a.head.workflowByOwner?.[reauthorIdx] ?? []);
      reauthorIdx++;
    }
  }
  flush();
  const out = reassembleNote(a.title, a.head.out, chunks);
  const afterWords = wordCount(out);
  const residue = a.head.residue.concat(edgePayloadResidue(a.source, out));
  const headVerbatim = a.reauthorText !== "" && a.head.status === "passthrough";
  const reCount = a.sections.filter((u) => u.route === "re-author").length;
  const preserveCount = a.sections.length - reCount;
  // deterministic, zero-LLM, never blocks — the routed head's own run skips this lint
  // (see pipeline.ts distill()), so assembleRoutedNote owns the one whole-note check.
  const nameLint = nameLintAgainstSource(out, a.source);
  const footer =
    `— per-section route: ${reCount} re-author / ${preserveCount} preserve` +
    ` · ${beforeWords}→${afterWords} words` +
    (headVerbatim ? " · head kept verbatim (prose not compressed)" : "") +
    (residue.length ? ` · ${residue.length} residue` : "") +
    formatNameLint(nameLint);
  return { out, footer, residue };
}

// ---- arg parsing + io ----
export const USAGE = `distill-text — abstractive idea-compression: rewrite a note as connective prose
backed by a certified glossary (and an optional ## Workflow of its directives).

Usage:
  distill-text [options] [input.md]              compress a note (stdin when no path or '-')
  distill-text prose [options] [glossary.md]     render prose FROM an already-distilled glossary

Options:
  --glossary            emit just the glossary (tie + definitions), no prose
  --lang <en|ru|auto>    language rubric (default: auto-detect)
  --max-retries <n>      cap stage-5 gate recovery retries (default: 2)
  --tau <0..1>           payload-density routing threshold (default: ${DEFAULT_TAU})
  --no-gate              skip the stage-5 fidelity gate
  --no-revise            skip the stage-4 writing passes
  --max-words <n>        expand-guard cap: 0 disables it, a positive n is an absolute ceiling
  --dry-run              deterministic front half only (segment→route report); no API call
  --out <dest.md>        compress-mode destination override (default: the input path);
                         required when reading from stdin once a run reaches the emit
  -h, --help             show this help and exit

Output:
  The input file is never modified. A distilled run writes an interactive review
  intermediary sibling to the destination, \`<dest>.tmp.md\` (destination defaults to
  the input path, overridable with --out): a decision block per residue item (verbs
  recover/keep) plus a mandatory trailing confirm-all gate stamped with dest=/src=.
  A passthrough run (failsafe, expand-guard, nothing to distill) instead writes a
  fresh temp .md holding the legacy envelope: <result>…</result> is exactly the text
  to write back to source, <residue> (omitted when empty) holds each item that
  failed a gate, with verbatim <source>. Either way, stdout carries exactly the
  data: one line, the written path (nothing on empty input). The one-line summary
  footer prints on stderr, with every other diagnostic. Capture is plain:
    path=$(distill-text input.md); status=$?
  Exit: 0 distilled or prose rendered (a pending review intermediary, residue, and
  gate-inconclusive items still exit 0 — they are surfaced in the footer and the
  intermediary itself) · 1 FIREWORKS_API_KEY
  missing · 2 usage error (compress mode: stdin without --out once the run reaches
  the emit; --out naming a missing directory) · 3 passthrough (the
  output is the unmodified original — compress failsafe, expand-guard, nothing to
  distill, and every prose-mode skip: no glossary table, empty prose, error; the
  path line still prints, the reason on stderr;
  empty input exits 3 with nothing on stdout) · 4 pending intermediary already
  exists at the sibling .tmp.md path (refused before the key gate and before any
  LLM call — apply or delete it first).

Env: FIREWORKS_API_KEY (e.g. doppler run --project claude-code --config std --)
`;

export type CliOpts = {
  lang: "en" | "ru" | "auto";
  maxRetries: number;
  noRevise: boolean;
  noGate: boolean;
  glossaryOnly: boolean;
  dryRun: boolean;
  tau: number;
  maxWords?: number;
  path?: string;
  /// Compress-only destination override (plan Q6): the intermediary is written
  /// sibling to THIS path (`<out minus .md>.tmp.md`) and apply derives its
  /// write-back target from it. Required when input is stdin AND the run reaches
  /// the emit (passthrough/no-body/empty paths never need a destination, which is
  /// what keeps the c4e0339 stdin recipe exit-3 behavior byte-identical).
  out?: string;
};

// parseArgs is the whole CLI surface as one pure argv→result function so main() can act
// on help/misuse BEFORE the API-key gate or any network call, and so the surface is unit-
// testable without spawning the binary. It returns a discriminated result:
//   { kind: "help" }                     -> print USAGE, exit 0
//   { kind: "error", message }           -> print to stderr, exit 2 (misuse)
//   { kind: "ok", mode, opts }           -> run
// Flags may appear in any position. Value-flags consume the following token, so that token
// is never mistaken for the positional path. Unknown flags (any dash-prefixed token that is
// not a known flag, single- or double-dash), out-of-set enum values, non-numeric/blank/out-of-
// range numbers, missing values, and extra positionals all fail loudly rather than silently
// falling back to a default (the pre-hardening behavior). `--` is the end-of-options marker: it
// stops flag parsing so a dash-prefixed input path can follow; a bare `-` stays a positional.
// The optional `prose` subcommand is recognized as the FIRST positional (so a leading flag no
// longer hides it, and a stray `prose` in second position errors instead of misparsing).
export type ParseResult =
  | { kind: "help" }
  | { kind: "error"; message: string }
  | { kind: "ok"; mode: "compress" | "prose" | "apply"; opts: CliOpts };

export function parseArgs(argv: string[]): ParseResult {
  let lang: CliOpts["lang"] = "auto";
  let maxRetries = 2;
  let tau = DEFAULT_TAU;
  let maxWords: number | undefined;
  let noExpandGuard = false;
  let noRevise = false;
  let noGate = false;
  let glossaryOnly = false;
  let dryRun = false;
  let out: string | undefined;
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") return { kind: "help" };
    // `--` is the end-of-options marker: everything after it is a positional, so a
    // dash-prefixed input path (e.g. a file literally named `-notes.md`) can be passed.
    if (a === "--") {
      for (let j = i + 1; j < argv.length; j++) positionals.push(argv[j]);
      break;
    }
    if (a === "--no-revise") {
      noRevise = true;
      continue;
    }
    if (a === "--no-gate") {
      noGate = true;
      continue;
    }
    if (a === "--glossary") {
      glossaryOnly = true;
      continue;
    }
    // Renamed surface (2026-07-04): point the muscle-memory forms at the new names
    // instead of letting them die as a generic unknown-flag / extra-argument error.
    if (a === "--core-only")
      return { kind: "error", message: "--core-only was renamed to --glossary" };
    if (a === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (a === "--no-expand-guard") {
      noExpandGuard = true;
      continue;
    }
    if (a === "--lang") {
      const v = argv[++i];
      if (v === undefined)
        return {
          kind: "error",
          message: "--lang expects a value (en, ru, or auto)",
        };
      if (v !== "en" && v !== "ru" && v !== "auto")
        return {
          kind: "error",
          message: `--lang expects one of: en, ru, auto (got '${v}')`,
        };
      lang = v;
      continue;
    }
    if (a === "--max-retries") {
      const v = argv[++i];
      if (v === undefined || v.trim() === "")
        return {
          kind: "error",
          message: "--max-retries expects a non-negative integer",
        };
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0)
        return {
          kind: "error",
          message: `--max-retries expects a non-negative integer (got '${v}')`,
        };
      maxRetries = n;
      continue;
    }
    if (a === "--tau") {
      const v = argv[++i];
      if (v === undefined || v.trim() === "")
        return { kind: "error", message: "--tau expects a number in [0, 1]" };
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 1)
        return {
          kind: "error",
          message: `--tau expects a number in [0, 1] (got '${v}')`,
        };
      tau = n;
      continue;
    }
    // --max-words <n>: customizes the expand-guard cap (expandGuardCap). 0 disables the
    // guard entirely — a debugging escape hatch to see what the model produced even when it
    // grew the note; a positive n sets an absolute ceiling; omitted keeps today's default
    // (revert on any growth past the note's own input size). --no-expand-guard is its alias for 0.
    if (a === "--max-words") {
      const v = argv[++i];
      if (v === undefined || v.trim() === "")
        return {
          kind: "error",
          message: "--max-words expects a non-negative integer",
        };
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0)
        return {
          kind: "error",
          message: `--max-words expects a non-negative integer (got '${v}')`,
        };
      maxWords = n;
      continue;
    }
    // --out: the compress-mode destination override (plan Q6). Value-checked here at
    // parse time — it must name a real .md destination, never the .tmp.md intermediary
    // itself; the stdin-requires---out refusal is a separate RUNTIME check (main()) so
    // the empty/no-body stdin exit-3 paths stay byte-identical.
    if (a === "--out") {
      const v = argv[++i];
      if (v === undefined || v.trim() === "")
        return {
          kind: "error",
          message: "--out expects a destination .md path",
        };
      if (v.endsWith(".tmp.md"))
        return {
          kind: "error",
          message: `--out must not name a .tmp.md intermediary (got '${v}')`,
        };
      if (!v.endsWith(".md"))
        return {
          kind: "error",
          message: `--out expects a .md destination (got '${v}')`,
        };
      out = v;
      continue;
    }
    // Any other dash-prefixed token is a flag typo (single- or double-dash), not a path —
    // name it, rather than misattributing an "extra argument" error to the following values
    // or ENOENT-crashing on it as a bogus filename. A bare `-` stays a positional.
    if (a.startsWith("-") && a !== "-") return { kind: "error", message: `unknown flag '${a}'` };
    positionals.push(a);
  }

  // Interpret positionals: an optional leading `prose` | `apply` subcommand, then the
  // input path. A leading flag no longer hides the subcommand (positionals are already
  // stripped of flags), and a stray subcommand in second position errors as an extra arg.
  let mode: "compress" | "prose" | "apply" = "compress";
  let rest = positionals;
  if (positionals[0] === "render")
    return { kind: "error", message: "the 'render' subcommand was renamed to 'prose'" };
  if (positionals[0] === "prose" || positionals[0] === "apply") {
    mode = positionals[0];
    rest = positionals.slice(1);
  }
  const path = rest[0];
  if (rest.length > 1)
    return {
      kind: "error",
      message: `unexpected extra argument(s): ${rest.slice(1).join(", ")}`,
    };

  // apply consumes exactly one intermediary and never reads stdin, so a missing path
  // is a usage error (not a stdin fallback); --dry-run names an action apply does not
  // have (there is nothing to preview — the intermediary IS the preview), exit 2.
  if (mode === "apply") {
    if (path === undefined)
      return { kind: "error", message: "apply requires an intermediary path (<name>.tmp.md)" };
    if (dryRun) return { kind: "error", message: "apply does not support --dry-run" };
  }

  // --out is compress-only: prose mode never derives a write-back destination.
  if (mode === "prose" && out !== undefined)
    return {
      kind: "error",
      message: "--out is compress-only (prose mode never derives a destination)",
    };

  // A positional `.tmp.md` compress input is the fat-finger for `apply` (it ends `.md`, so
  // the non-.md check below waves it through) — distilling scaffold text and stamping
  // dest=<name>.tmp.md is never intended. Mirror --out's own .tmp.md rejection; point at apply.
  if (mode === "compress" && path !== undefined && path.endsWith(".tmp.md"))
    return {
      kind: "error",
      message: `'${path}' is an intermediary — did you mean 'distill-text apply ${path}'?`,
    };

  // A compress-mode file input with no --out becomes the write-back destination, and the
  // .tmp.md ↔ .md round-trip (tmpPathFor / destinationFor) only closes on a .md name — a
  // `note.txt` would emit `note.txt.tmp.md`, stamp dest=note.txt, and apply would derive
  // note.txt.md, a stamp that can never match (a full LLM run wasted on an un-appliable
  // intermediary). Reject at parse time, before any work; --out (validated .md) or stdin
  // both escape it, since the destination then comes from --out rather than the input.
  // --dry-run never writes back (it prints a routing report), so the round-trip rationale
  // does not apply — it keeps taking any input.
  if (
    mode === "compress" &&
    !dryRun &&
    out === undefined &&
    path !== undefined &&
    path !== "-" &&
    !path.endsWith(".md")
  )
    return {
      kind: "error",
      message: `compress input must be a .md file, or pass --out <dest.md> (got '${path}')`,
    };

  // --no-expand-guard is sugar for --max-words 0; a conflicting positive --max-words is a
  // contradiction, so reject it rather than silently letting one win.
  if (noExpandGuard) {
    if (maxWords !== undefined && maxWords !== 0)
      return {
        kind: "error",
        message: `--no-expand-guard conflicts with --max-words ${maxWords} (it means --max-words 0)`,
      };
    maxWords = 0;
  }

  return {
    kind: "ok",
    mode,
    opts: {
      lang,
      maxRetries,
      noRevise,
      noGate,
      glossaryOnly,
      dryRun,
      tau,
      maxWords,
      path,
      out,
    },
  };
}

// Create an empty temp file with a .md extension and return its path. The result
// is written here instead of stdout so the caller gets a real .md artifact
// (openable, diffable) and stdout carries only the path (footer on stderr).
function tempMdPath(): string {
  return execFileSync("mktemp", ["--suffix=.md"], { encoding: "utf8" }).trim();
}

// The pending-review intermediary sibling for a destination. `note.md` →
// `note.tmp.md`; a destination without the .md suffix APPENDS `.tmp.md` instead
// of replacing — a bare replace() no-ops on `note.txt`, making tmpPath === dest,
// so the exit-4 preflight would refuse on the input file's own existence and the
// success write would clobber the input (both observed pre-fix).
function tmpPathFor(dest: string): string {
  return dest.endsWith(".md") ? dest.replace(/\.md$/, ".tmp.md") : `${dest}.tmp.md`;
}

// The exit-4 pending-intermediary refusal (plan §4), shared by the pre-key preflight
// and the no-clobber final write (a racing emit's loser). The mtime staleness hint
// (tmpfile F5) tells the reviewer whether the pending file is this morning's review
// or a weeks-old orphan; refusal is loud either way.
function refusePendingIntermediary(tmpPath: string): never {
  let age = "";
  try {
    const mins = Math.round((Date.now() - statSync(tmpPath).mtimeMs) / 60000);
    const label =
      mins < 60
        ? `${mins}m`
        : mins < 1440
          ? `${Math.round(mins / 60)}h`
          : `${Math.round(mins / 1440)}d`;
    age = ` (${label} old)`;
  } catch {} // a hint only: a vanished/unstattable file changes nothing about the refusal
  console.error(
    `distill: pending intermediary exists: ${tmpPath}${age} — apply it or delete it before re-running`,
  );
  process.exit(4);
}

// ---- TTY session (Phase 5, plan §4): sugar over emit+apply, never a third code path ----

/// One `prompt [y/N]` round-trip against the real terminal: the prompt lands on
/// stderr (stdout stays the frozen one-line path even at a TTY), the answer
/// comes from stdin. A fresh readline.Interface per call — this is a handful of
/// round-trips per session, not a hot loop. EOF (Ctrl-D) or a stream error
/// resolves null, which the caller treats as decline; readline's own Ctrl-C
/// handling is not engaged (`terminal` defaults off without a matching `output`),
/// so Ctrl-C falls through to the SIGINT handler main() installs around the session.
function ask(prompt: string): Promise<string | null> {
  return new Promise((resolvePrompt) => {
    process.stderr.write(prompt);
    const rl = createInterface({ input: process.stdin });
    let answered = false;
    rl.once("line", (line) => {
      answered = true;
      rl.close();
      resolvePrompt(line);
    });
    rl.once("close", () => {
      if (!answered) resolvePrompt(null);
    });
  });
}

const isYes = (answer: string | null): boolean =>
  answer !== null && answer.trim().toLowerCase() === "y";

/// The gate-aware sugar loop (plan §4 transcript): re-reads `tmpPath` from disk on
/// every iteration (Sync may have landed a cross-device edit between prompts), so
/// it never asks a question the file itself already answers. The confirm-all gate
/// (triage.ts always names it "triage-final") unchecked → a diagnosis prompt whose
/// "y" only asks for a re-read, never substitutes for the tick; gate fully checked →
/// one count-confirm naming what apply is about to do, then `runApply` runs
/// in-process with its stdout REDIRECTED to stderr for the duration of the call —
/// the stdout path line belongs to emit alone, even in-session. Any
/// non-"y" answer or EOF returns 0 with the intermediary untouched; the file
/// predates the prompt, so nothing is lost. `askFn` is the injection seam unit
/// tests use to script answers without a real terminal; production always uses the
/// real `ask` above.
export async function runTtySession(
  tmpPath: string,
  dest: string,
  lang: "en" | "ru",
  askFn: (prompt: string) => Promise<string | null> = ask,
): Promise<number> {
  for (;;) {
    if (!existsSync(tmpPath)) return 0; // consumed already — a racing apply, or a hand delete
    const { blocks } = parseInteract(readFileSync(tmpPath, "utf8"));
    const gate = blocks.find((b) => b.kind === "confirm-all");
    const gateChecked =
      gate !== undefined &&
      gate.items.length > 0 &&
      gate.items.every((it) => it.state === "checked");
    if (!gateChecked) {
      const gateId = gate?.id ?? "triage-final";
      const answer = await askFn(
        `gate '${gateId}' unchecked — check it in Obsidian, then press y to re-check [y/N] `,
      );
      if (!isYes(answer)) return 0;
      continue; // re-read before asking again — the tick is the file's, not the terminal's
    }
    const items = blocks.filter((b) => b.kind !== "confirm-all").flatMap((b) => b.items);
    const recovered = items.filter((it) => it.state === "checked" && it.verb === "recover").length;
    const kept = items.filter((it) => it.state === "checked" && it.verb === "keep").length;
    const removed = items.filter((it) => it.state === "unchecked").length;
    const answer = await askFn(
      `about to write: ${recovered} recovered · ${kept} kept · ${removed} removed → ${dest} — confirm [y/N] `,
    );
    if (!isYes(answer)) return 0;
    const realStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) =>
      process.stderr.write(chunk)) as typeof process.stdout.write;
    try {
      return await runApply(tmpPath, { lang });
    } finally {
      process.stdout.write = realStdoutWrite;
    }
  }
}

export async function main() {
  // The whole CLI surface resolves in parseArgs (help/misuse/ok). Act on help and misuse
  // here, before the API-key gate or any network call: help prints usage to stdout and exits
  // 0; a parse error prints to stderr and exits 2 (distinct from the runtime exit 1/0 paths).
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.kind === "help") {
    process.stdout.write(USAGE);
    return;
  }
  if (parsed.kind === "error") {
    console.error(`distill: ${parsed.message}\nTry 'distill-text --help' for usage.`);
    process.exit(2);
    return; // process.exit ends the run; the explicit return also narrows `parsed` to "ok" below
  }
  const { mode } = parsed;
  const {
    lang,
    maxRetries,
    noRevise,
    noGate,
    glossaryOnly,
    dryRun,
    tau,
    maxWords,
    path: inputPath,
    out: outOpt,
  } = parsed.opts;
  // apply is a structurally distinct verb: it consumes a previously-emitted
  // intermediary, checks the key LAZILY (only a checked recover DEF needs an LLM), and
  // does its own path-on-stdout + footer/refusal-on-stderr. Dispatched BEFORE the compress-mode
  // exit-4 preflight and the API-key gate below, so a keyless reject-all triage applies
  // offline. parseArgs guarantees inputPath is present in this mode.
  if (mode === "apply") {
    process.exit(await runApply(inputPath as string, { lang }));
  }
  const fromStdin = inputPath === undefined || inputPath === "-";
  // The compress-mode write-back destination: --out when given, else the input path
  // (stdin with no --out has none yet — that is a runtime refusal below, once the
  // run actually reaches the emit, so the no-body/empty-input exit-3 paths stay
  // byte-identical). Both the exit-4 preflight and the success emit key off this.
  // Resolved to absolute so stdout line 1 stays openable from any later cwd (the
  // mktemp contract was always absolute; the plan-§4 transcript shows an absolute
  // line 1 for a relative invocation) — agent callers re-open $path after a cwd reset.
  const destRel = outOpt ?? (fromStdin ? undefined : inputPath);
  const dest = destRel === undefined ? undefined : resolve(destRel);
  // A bare `distill-text` at a terminal would hang silently on fd 0; say so.
  const stdinHint = (): void => {
    if (fromStdin && process.stdin.isTTY)
      console.error("distill: reading stdin — pass a file or pipe input (ctrl-d ends input)");
  };
  // Phase 3 preflight: refuse BEFORE the API-key gate and before any LLM call when a
  // prior review intermediary is still pending at the sibling .tmp.md path — nothing
  // written, no stdout, so a stuck run never masquerades as fresh progress. An --out
  // whose directory is absent is a usage error caught here too: the destination file
  // may be new (creation case) but its directory must exist, or the run would burn
  // the whole LLM budget and die on the final write.
  if (mode === "compress" && !dryRun && dest !== undefined) {
    if (outOpt !== undefined && !existsSync(dirname(dest))) {
      console.error(`distill: --out directory does not exist: ${dirname(dest)}`);
      process.exit(2);
      return;
    }
    const tmpPath = tmpPathFor(dest);
    if (existsSync(tmpPath)) refusePendingIntermediary(tmpPath);
  }
  // --dry-run (Backlog 9): the deterministic front half only — segment → per-section
  // payload density → route. Prints the report and returns, writing nothing, making no
  // LLM call, needing no API key. Runs on the note body (frontmatter stripped).
  if (dryRun) {
    stdinHint();
    const input = readFileSync(fromStdin ? 0 : (inputPath as string), "utf8");
    const { body } = parseFrontmatter(input);
    const label = fromStdin ? "(stdin)" : (inputPath as string);
    process.stdout.write(formatDryRun(label, routeNote(body, tau)) + "\n");
    return;
  }
  if (!process.env.FIREWORKS_API_KEY) {
    console.error(
      "FIREWORKS_API_KEY not set (run under: doppler run --project claude-code --config std --)",
    );
    process.exit(1);
  }
  stdinHint();
  const input = readFileSync(fromStdin ? 0 : (inputPath as string), "utf8");
  if (!input.trim()) {
    console.error("distill skipped: empty input");
    process.exit(3);
  }
  // Lazy: mktemp CREATES the file, and the Phase-3 success path never uses it —
  // an eager call would orphan one empty temp file per successful distill. Only
  // the passthrough/error/no-body/prose paths (the `emit` callers) pay for it.
  let mktempPath: string | undefined;
  const emit = (body: string, footer: string): void => {
    const path = (mktempPath ??= tempMdPath());
    writeFileSync(path, body);
    process.stdout.write(`${path}\n`);
    process.stderr.write(`${footer}\n`);
  };
  // A full run is tens of seconds of LLM calls; tick per stage, TTY-gated so
  // scripts and parent loops never see it.
  const progress = process.stderr.isTTY
    ? (line: string): void => void process.stderr.write(`${line}\n`)
    : undefined;
  if (mode === "prose") {
    // runProse returns the exit code: 0 rendered, 3 skipped (output = the
    // unmodified input — the same code compress passthrough uses).
    process.exit(await runProse(input, { lang, noRevise }, emit));
  }
  // compress mode: strip leading frontmatter (it passes through verbatim; the
  // pipeline + language detection operate on the body only). A block whose YAML
  // failed to parse is flagged (not demoted to body) so it is surfaced in the
  // footer rather than silently reworded as prose.
  const { front, body, error: fmError } = parseFrontmatter(input);
  if (!body.trim()) {
    emit(input, "— no body to distill");
    process.exit(3);
  }
  // stdin without --out: a real body means this run WILL reach the emit, and stdin
  // has no destination to name the sibling .tmp.md after. Fires here (after the
  // no-body check, not in parseArgs) so the empty/no-body stdin exit-3 paths above
  // stay byte-identical (stages.test.ts:656's recipe test pins that).
  if (dest === undefined) {
    console.error("distill: stdin input requires --out to name the destination");
    process.exit(2);
  }
  const resolved = lang === "auto" ? detectLang(body) : lang;
  const frontDescription = parseDescription(front);
  // D30: a type:reference body must stay link-free (no ## Relations). distill emits
  // no references today, so this only future-proofs a reference-distill path.
  const isReference = parseType(front) === "reference";
  // D46 genre gate: a superseded note or a "Context document" is licensed to drop wholesale,
  // so the prose-list-item gate would only flood the footer — skip it there (the deterministic
  // spine still runs). Computed here, where the raw frontmatter is in scope.
  const factsDump = parseSuperseded(front) || /context document/i.test(frontDescription);
  // the note's canonical self-slug is its filename slug (what other vault notes
  // wikilink to); empty when reading from stdin (including the '-' convention), where
  // distill() falls back to the H1.
  const selfSlug =
    !fromStdin && inputPath ? slugSegment(basename(inputPath).replace(/\.md$/, "")) : "";
  try {
    const { out, footer, residue, status } = await distill(
      body,
      resolved,
      frontDescription,
      {
        maxRetries,
        noRevise,
        noGate,
        glossaryOnly,
        isReference,
        factsDump,
        tau,
        maxWords,
        progress,
      },
      selfSlug,
    );
    const footer2 = fmError
      ? `${footer} · frontmatter not parsed (kept verbatim): ${fmError.slice(0, 80)}`
      : footer;
    // exit 3: covers nothing-to-distill and the expand-guard revert — the output is the
    // unmodified original. A routed note is always "compressed" (its preserves were
    // compacted), so head-kept-verbatim exits 0 with the footer tag as the signal. This
    // legacy passthrough envelope (mktemp <result>/<residue>) is untouched — Phase 3
    // only swaps the SUCCESS path below to the review intermediary.
    if (status === "passthrough") {
      const front2 = ensureEpistemicStatus(front);
      const result = front2 ? front2 + "\n" + out : out;
      let fileBody = `<result>\n${result}\n</result>\n`;
      if (residue.length) {
        const entries = residue
          .map(
            (r) =>
              `<entry term="${escAttr(r.label)}" reason="${escAttr(r.reason)}">\n<source>\n${r.source}\n</source>\n</entry>`,
          )
          .join("\n");
        fileBody += `\n<residue>\n${entries}\n</residue>\n`;
      }
      emit(fileBody, footer2);
      process.exit(3);
    }
    // Phase 3 success: write the interactive review intermediary sibling to `dest`
    // (never the source itself — the input file is never modified), stamped with
    // dest= (the destination basename) and src= (a hash of dest's current bytes, or
    // "new" when it does not yet exist — the creation case).
    const destPath = dest as string; // narrowed above: stdin without --out already exited
    const tmpPath = tmpPathFor(destPath);
    const noteForIntermediary = front ? `${front}\n${out}` : out;
    const src = existsSync(destPath)
      ? `sha256:${createHash("sha256").update(readFileSync(destPath)).digest("hex").slice(0, 12)}`
      : "new";
    const intermediary = buildIntermediary(noteForIntermediary, residue, {
      dest: basename(destPath),
      src,
    });
    // Atomic no-clobber (plan §4, atomicity F2/F7): write a sibling .partial, then
    // linkSync to the final name — link fails EEXIST instead of overwriting, so a
    // racing emit that passed the preflight minutes ago (LLM run) loses LOUD with
    // the same exit-4 refusal, and a crash mid-write never leaves a truncated
    // intermediary visible at the .tmp.md path.
    const partial = `${tmpPath}.partial`;
    writeFileSync(partial, intermediary);
    try {
      linkSync(partial, tmpPath);
    } catch (e) {
      try {
        unlinkSync(partial);
      } catch {}
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        refusePendingIntermediary(tmpPath);
      }
      throw e;
    }
    unlinkSync(partial);
    const reviewSuffix =
      residue.length > 0 ? ` · review: ${residue.length} items + gate` : " · review: gate";
    process.stdout.write(`${tmpPath}\n`);
    process.stderr.write(`${footer2}${reviewSuffix}\n`);
    // Phase 5: at a real terminal (both ends — command substitution and pipes must
    // never see a prompt), emit's success hands off to the gate-aware session in the
    // SAME process. Everything below this line is stderr; stdout is already frozen
    // at the path line above. Not a TTY (the overwhelmingly common agent-caller
    // case): fall through unchanged, exiting 0 exactly as before Phase 5.
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const reviewLabel = residue.length > 0 ? `${residue.length} items + gate` : "gate";
      process.stderr.write(`review: ${tmpPath} — ${reviewLabel}\n`);
      process.stderr.write(`apply later with: distill-text apply ${tmpPath}\n`);
      // Ctrl-C loses nothing (the intermediary is already on disk) — exit 0 rather
      // than the default SIGINT death, matching decline/EOF's exit code.
      process.once("SIGINT", () => process.exit(0));
      process.exit(await runTtySession(tmpPath, destPath, resolved));
    }
  } catch (e) {
    // A non-transient throw is a real bug — surface it (a stage catch has already
    // logged it on its way up; anything thrown outside a stage prints its own stack
    // on propagation) instead of shipping the original as a silent passthrough.
    // a truncation in a NO-CATCH core stage (extractCombo, gradeBlocks) is not a
    // transient flake and not a code bug: it skips THIS note with a clear actionable
    // footer (raise the stage's cap), never a raw stack crash or a "transient" label.
    // exit 3: valid but unmodified original.
    if (e instanceof TruncationError) {
      emit(input, `— distill skipped: output TRUNCATED — ${e.message}`);
      process.exit(3);
    }
    if (!isTransient(e)) throw e;
    // transient failsafe: temp file holds the original (passthrough); path still printed
    emit(input, `— distill skipped (error): ${String(e).slice(0, 160)}`);
    process.exit(3);
  }
}
