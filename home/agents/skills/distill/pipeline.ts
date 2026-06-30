// pipeline — the orchestration layer: the five-stage compress pipeline (distill),
// arg parsing, the temp-file sink, and main(). Sequences the stages from prompts.ts
// behind the seams the leaf modules stabilize; main() is invoked by the entrypoint.
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { execFileSync } from "node:child_process";
import {
  type Block,
  type Grade,
  type GlossEntry,
  type IR,
  type LinkInventory,
  type ProseUnit,
  type WorkStep,
  type PayloadSpan,
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
  normalizeTypography,
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
  type Concept,
  type StepVerdict,
  type Synth,
  connectiveProse,
  extractCombo,
  fidelityGate,
  gradeBlocks,
  PASS_EN,
  PASS_RU,
  type ProseVerdict,
  proseFix,
  proseGate,
  proseJudge,
  renderEntryPrompt,
  repairWorkflowGroup,
  revise,
  sourceTextFor,
  synthEntries,
  synthWorkflow,
  tieTogether,
  verbatimDirectives,
  workflowGate,
} from "./prompts.ts";
import { assembleBody, escAttr } from "./assemble.ts";
import { runRender } from "./render-mode.ts";

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
type Residue = { term: string; reason: string; source: string };
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

// stage 2: grade + order (pure). Given the extracted IR, the segmented blocks, and
// their per-block grades, pick the retained-verbatim blocks and put the glossary
// entries and workflow steps in the note's own order (first appearance of their
// lowest source block, Array.sort stable across a shared block). A step whose every
// source block is retained verbatim is already carried by that block — drop it so
// the directive is not duplicated as both a fence and a step. Deterministic.
export function orderContent(
  ir: IR,
  blocks: Block[],
  grades: Map<string, Grade>,
): {
  retained: Block[];
  retainedIds: Set<string>;
  orderedEntries: GlossEntry[];
  orderedSteps: WorkStep[];
} {
  const blockIndex = new Map(blocks.map((b, i) => [b.id, i]));
  const retained = blocks.filter((b) => grades.get(b.id) === "retain");
  const retainedIds = new Set(retained.map((b) => b.id));
  const orderKey = (e: { source: string[] }) =>
    Math.min(...e.source.map((id) => blockIndex.get(id) ?? 1e9));
  const orderedEntries = [...ir.glossary].sort((a, b) => orderKey(a) - orderKey(b));
  const orderedSteps = ir.workflow
    .filter((s) => !s.source.every((id) => retainedIds.has(id)))
    .sort((a, b) => orderKey(a) - orderKey(b));
  return { retained, retainedIds, orderedEntries, orderedSteps };
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
// short tie-together (the gate's thesis anchor, and the head in --core-only), and
// the per-step workflow. These three are independent, so they run concurrently; the
// connective prose body needs the defs, so it follows (skipped in --core-only).
async function synthesize(
  ir: IR,
  orderedEntries: GlossEntry[],
  orderedSteps: WorkStep[],
  opts: { synth: Synth; coreOnly: boolean },
  blockById: Map<string, Block>,
  lang: "en" | "ru",
): Promise<{
  defByTerm: Map<string, string>;
  tie: string;
  workflowSteps: string[];
  prose: string;
}> {
  const [defByTerm, tie, workflowSteps] = await Promise.all([
    synthEntries(ir, orderedEntries, opts.synth, blockById, lang),
    tieTogether(ir, lang),
    synthWorkflow(orderedSteps, opts.synth, blockById, lang),
  ]);
  const prose = opts.coreOnly ? "" : await connectiveProse(ir, orderedEntries, defByTerm, lang);
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
  const rev = await revise(dblocks, passes, termLiterals);
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
  ir: IR,
  h1: string,
  tie: string,
  orderedEntries: GlossEntry[],
  orderedSteps: WorkStep[],
  defByTerm: Map<string, string>,
  workflowSteps: string[],
  retained: Block[],
  blockById: Map<string, Block>,
  lang: "en" | "ru",
  opts: { maxRetries: number; isReference: boolean },
): Promise<{ residue: Residue[]; retries: number; gateSkipped: number; keptVerbatim: number }> {
  const stepGroups = computeStepGroups(orderedSteps, blockById);
  let gloss = assembleBody(
    h1,
    tie,
    workflowSteps,
    orderedEntries,
    defByTerm,
    retained,
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
    fidelityGate(ir.thesis, gloss, renderedC()),
    workflowGate(renderedG(), lang),
  ]);
  const thesisRecoverable = graded.thesisRecoverable;
  // inconclusive verdicts (judge returned no JSON) are set aside from the start:
  // recovery cannot fix them, so they bypass the retry loop and surface directly.
  const inconclusiveC = new Map<string, Concept>();
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
              "render",
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
      retained,
      opts.isReference,
    );
    // re-grade only the patched items, not the full set (budget)
    const patchC = new Set(failC.map((c) => c.term));
    const patchG = new Set(failG.map((g) => g.id));
    const [reg, regG] = await Promise.all([
      patchC.size
        ? fidelityGate(
            ir.thesis,
            gloss,
            renderedC().filter((r) => patchC.has(r.term)),
          )
        : Promise.resolve({ thesisRecoverable, concepts: [] as Concept[] }),
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
        retained,
        opts.isReference,
      );
    }
  }
  // surviving residue (incl. an unrecoverable thesis) is surfaced, never silent
  for (const c of failC) {
    const entry = orderedEntries.find((e) => e.term === c.term);
    residue.push({
      term: c.term,
      reason: `${c.direction || "residue"}: ${c.missing || "failed round-trip entailment"}`,
      source: entry ? sourceTextFor(entry, blockById) : "",
    });
  }
  for (const v of failG) {
    const g = stepGroups.find((x) => x.id === v.id);
    residue.push({
      term: v.id,
      reason: `workflow: ${v.missing || "directive coverage failed"}`,
      source: g ? g.sourceText : "",
    });
  }
  if (!thesisRecoverable) {
    residue.unshift({
      term: "(thesis)",
      reason: "thesis not recoverable from output",
      source: ir.thesis,
    });
  }
  // gate-inconclusive items: the judge could not render a verdict (no JSON after
  // retry). Ship them surfaced-but-unverified, distinct from genuine residue, so a
  // judge flake never discards the run — the floor under the passthrough failsafe.
  for (const c of inconclusiveC.values()) {
    const entry = orderedEntries.find((e) => e.term === c.term);
    residue.push({
      term: c.term,
      reason: `gate-inconclusive: ${c.missing || "judge returned no verdict"}`,
      source: entry ? sourceTextFor(entry, blockById) : "",
    });
  }
  for (const v of inconclusiveG.values()) {
    const g = stepGroups.find((x) => x.id === v.id);
    residue.push({
      term: v.id,
      reason: `gate-inconclusive: ${v.missing || "judge returned no verdict"}`,
      source: g ? g.sourceText : "",
    });
  }
  gateSkipped = inconclusiveC.size + inconclusiveG.size;
  return { residue, retries, gateSkipped, keptVerbatim };
}

// prose QA: judge the un-gated readable head against its own contract and repair
// best-effort. One judge + one fix pass — defects never block, so no re-judge.
// Sits BELOW the fidelity line; the caller rides it on the --no-gate switch and
// skips it in --core-only (no prose).
async function runProseQA(
  thesis: string,
  prose: string,
  lang: "en" | "ru",
): Promise<{ prose: string; proseFixes: number }> {
  const pj = await proseJudge(thesis, prose);
  if (!pj.pass && pj.issues.length) {
    return { prose: await proseFix(prose, pj.issues, lang), proseFixes: pj.issues.length };
  }
  return { prose, proseFixes: 0 };
}

// build the success footer line — the one-line summary stdout carries beside the
// temp-file path. Pure; the nothing-to-distill and expansion guards in distill()
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
  coreOnly: boolean;
  proseGateOffFactsDump: boolean;
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
  const shapeTag = m.coreOnly ? "gloss" : "prose+gloss";
  // the prose gate would have run (!noGate && !coreOnly) but the facts-dump genre gate
  // skipped it — surface the skip so disabling a loss detector is never silent.
  const proseGateTag = m.proseGateOffFactsDump ? ` · prose-gate off (facts-dump)` : "";
  return `— distilled ${shapeTag} · ${m.beforeWords}→${m.afterWords} words (${sizeTag}) · ${m.entries} entries${stepsTag} · ${m.verbatim} verbatim · ${m.residue} residue${gateTag}${verbatimTag}${retriesTag}${proseTag}${proseGateTag}`;
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
          term: markup,
          reason:
            "wikilink slug-collision: distinct source edges share a slug; output coverage is ambiguous — verify each manually",
          source: markup,
        });
      }
      continue;
    }
    if (covered.has(slug)) continue;
    const markup = g.markups[0];
    residue.push({
      term: markup,
      reason: "wikilink dropped: source edge absent from output (no relation, no retained block)",
      source: markup,
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
const PAYLOAD_LANES: { harvest: (t: string) => PayloadSpan[]; reason: string }[] = [
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
      residue.push({ term: s.markup, source: s.markup, reason: lane.reason });
    }
  }
  return residue;
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
        term: u.id,
        source: u.span,
        reason: flaked.has(u.id)
          ? "prose-inconclusive: judge returned no verdict for this item's batch"
          : "prose-inconclusive: judge omitted this item from its verdict",
      });
      continue;
    }
    if (v.grade === "covered" && anchored(v, u.span, normOut)) continue; // the ONLY clear
    residue.push({
      term: u.id,
      source: u.span,
      reason:
        v.grade === "dropped"
          ? `prose dropped: ${v.missing || "list-item information absent from output"}`
          : "prose-inconclusive: covered verdict not anchored to a verifiable, on-topic output location",
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
    synth: Synth;
    maxRetries: number;
    noRevise: boolean;
    noGate: boolean;
    coreOnly: boolean;
    isReference: boolean;
    factsDump: boolean;
    tau: number;
  },
  selfSlug = "",
  routed = false,
): Promise<{ out: string; footer: string; residue: Residue[] }> {
  // Per-section render-router (D12/D16, Backlog 10). When a note carries any payload-dense
  // section, route: re-author the idea sections into ONE compact head (recurse — the head is
  // itself a homogeneous distill, which gives the expand guard scoped to its own source), hold
  // the payload sections verbatim (compactSection v1), reassemble in source order into one
  // note. `routed` guards the one-level recursion: the head re-enters with routing skipped.
  if (!routed && !opts.coreOnly) {
    const { title, units } = partition(text, opts.tau);
    const preserve = units.filter((u) => u.route === "preserve");
    if (preserve.length > 0) {
      return distillRouted(text, title, units, preserve, lang, frontDescription, opts, selfSlug);
    }
  }
  const blocks = segment(text);
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
  const ir = await extractCombo(blocks, frontDescription, lang, linkInventory, effectiveSelfSlug);
  if (ir.glossary.length === 0 && ir.workflow.length === 0) {
    return { out: text, footer: `— nothing to distill · ${beforeWords} words`, residue: [] };
  }

  // 2. grade blocks, then order entries/steps (pure)
  const grades = await gradeBlocks(ir, blocks);
  const { retained, orderedEntries, orderedSteps } = orderContent(ir, blocks, grades);

  // 3. synthesize defs + tie + workflow + connective prose body
  const synth = await synthesize(ir, orderedEntries, orderedSteps, opts, blockById, lang);
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
    ({ residue, retries, gateSkipped, keptVerbatim } = await runFidelityGate(
      ir,
      h1,
      tie,
      orderedEntries,
      orderedSteps,
      defByTerm,
      workflowSteps,
      retained,
      blockById,
      lang,
      { maxRetries: opts.maxRetries, isReference: opts.isReference },
    ));
  }

  // prose QA: judge the un-gated readable head and repair best-effort. Rides the
  // --no-gate switch; no-op in --core-only (no prose).
  let proseFixes = 0;
  if (prose && !opts.noGate) {
    const qa = await runProseQA(ir.thesis, prose, lang);
    prose = qa.prose;
    proseFixes = qa.proseFixes;
  }

  // assemble the final output: the connective prose head by default, the tie in
  // --core-only. Definitions are the gate-settled ones; the prose restates none
  // of them, so recovery changing a def never invalidates the prose above it.
  const out = assembleBody(
    h1,
    opts.coreOnly ? tie : prose,
    workflowSteps,
    orderedEntries,
    defByTerm,
    retained,
    opts.isReference,
  );

  const afterWords = wordCount(out);
  // passthrough guard: a distillation that expands the note has failed its one job.
  // Ship the original body rather than the larger output. (the footer's +N% only
  // flagged this after the fact; this prevents it.)
  if (afterWords > beforeWords) {
    return {
      out: text,
      footer: `— distillation expanded ${beforeWords}→${afterWords} words; kept original`,
      residue: [],
    };
  }
  // prose-list-item gate (D46): a glm matcher over a deterministic inventory of explicit
  // list-items under a heading — the must-cover prose class the spine is blind to and the
  // fidelity/workflow gates never see. An LLM call, so it rides --no-gate like runFidelityGate;
  // skipped in --core-only (no prose body to cover into) and on facts/context dumps (wholesale
  // drop is licensed there, so the inventory would only flood the footer). EXCLUSION-3 drops
  // items already folded into a graded def or step (sourceTextFor / StepGroup.sourceText), so
  // the matcher only judges list-items the existing gates do not. Appends to residue only.
  if (!opts.noGate && !opts.coreOnly && !opts.factsDump) {
    const claimed = [
      ...orderedEntries.map((e) => sourceTextFor(e, blockById)),
      ...computeStepGroups(orderedSteps, blockById).map((g) => g.sourceText),
    ];
    const units = harvestProseListItems(text, claimed);
    residue = residue.concat(await runProseGate(units, out, lang));
  }

  // edge-coverage gate: surface any source [[wikilink]] the distilled output dropped
  // as residue. Deterministic and free, so it runs even under --no-gate — a dropped
  // cross-note edge is irreversible loss the fidelity gate never checks. `out` is the
  // final body (prose + ## Relations + retained), so a link surviving in any of them
  // counts as covered.
  // The routed head (routed=true) skips this: distillRouted runs these gates ONCE at
  // whole-note scope (assembleRoutedNote, over source + reassembled out), so a link
  // surviving in a preserve section is not false-flagged against the head's narrower
  // subset and a real drop is not double-counted. The head still contributes its
  // fidelity/workflow/prose-list residue above.
  if (!routed) {
    residue = residue.concat(wikilinkResidue(text, out), payloadResidue(text, out));
  }
  const footer = buildFooter({
    beforeWords,
    afterWords,
    entries: orderedEntries.length,
    steps: orderedSteps.length,
    verbatim: retained.length,
    residue: residue.length,
    gateSkipped,
    keptVerbatim,
    retries,
    proseFixes,
    coreOnly: opts.coreOnly,
    // the prose gate is in scope (!noGate && !coreOnly) but the facts-dump genre gate
    // skipped it above — flag the disabled loss detector instead of dropping it silently.
    proseGateOffFactsDump: !opts.noGate && !opts.coreOnly && opts.factsDump,
  });
  return { out, footer, residue };
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
  units: { route: string; text: string }[],
  preserve: { text: string }[],
  lang: "en" | "ru",
  frontDescription: string,
  opts: Parameters<typeof distill>[3],
  selfSlug: string,
): Promise<{ out: string; footer: string; residue: Residue[] }> {
  const reauthorText = units
    .filter((u) => u.route === "re-author")
    .map((u) => u.text)
    .join("\n\n")
    .trim();
  const head = reauthorText
    ? await distill(reauthorText, lang, frontDescription, opts, selfSlug, true)
    : { out: "", footer: "", residue: [] as Residue[] };
  return assembleRoutedNote({
    source: text,
    title,
    reauthorText,
    head,
    preserveTexts: preserve.map((u) => u.text),
    reCount: units.length - preserve.length,
  });
}

// Pure seam of the per-section routed build (the no-LLM tail of distillRouted): reassemble the
// routed note, run the deterministic edge+payload gates ONCE at whole-note scope, and build the
// footer. No model and no I/O, so distillRouted's wiring is unit-testable in pure.test.ts. The
// residue-scope fix lives here: the routed head call (routed=true) now skips its own per-subset
// edge/payload run (see distill's !routed guard), so these wikilinkResidue/payloadResidue calls
// over (source, reassembled out) are the only such gates on a routed build — a link surviving in
// a preserve section reads as covered (no false drop) and a real drop counts once (no double-
// count). The verbatim-head tag surfaces a head the inner expand or nothing-to-distill guard
// returned unchanged; reauthorText !== "" excludes the empty-head / all-preserve route (where
// head.out === reauthorText === "") from tagging.
export function assembleRoutedNote(a: {
  source: string;
  title: string;
  reauthorText: string;
  head: { out: string; residue: Residue[] };
  preserveTexts: string[];
  reCount: number;
}): { out: string; footer: string; residue: Residue[] } {
  const beforeWords = wordCount(a.source);
  const preserves = a.preserveTexts.map((t) => compactSection(t));
  const out = reassembleNote(a.title, a.head.out, preserves);
  const afterWords = wordCount(out);
  const residue = a.head.residue.concat(
    wikilinkResidue(a.source, out),
    payloadResidue(a.source, out),
  );
  const headVerbatim = a.reauthorText !== "" && a.head.out === a.reauthorText;
  const footer =
    `— per-section route: ${a.reCount} re-author / ${a.preserveTexts.length} preserve` +
    ` · ${beforeWords}→${afterWords} words` +
    (headVerbatim ? " · head kept verbatim (prose not compressed)" : "") +
    (residue.length ? ` · ${residue.length} residue` : "");
  return { out, footer, residue };
}

// ---- arg parsing + io ----
// Flags may appear in any position. Value-flags (--lang/--synth/--max-retries)
// consume the following token as their value, so that token is never mistaken for
// the positional path. The first token that is neither a flag nor a flag's
// consumed value is the input file path.
function parseArgs(argv: string[]): {
  lang: "en" | "ru" | "auto";
  synth: Synth;
  maxRetries: number;
  noRevise: boolean;
  noGate: boolean;
  coreOnly: boolean;
  dryRun: boolean;
  tau: number;
  path?: string;
} {
  let lang: "en" | "ru" | "auto" = "auto";
  let synth: Synth = "render";
  let maxRetries = 2;
  let tau = DEFAULT_TAU;
  let path: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--lang" && argv[i + 1]) {
      lang = argv[++i] as "en" | "ru" | "auto";
      continue;
    }
    if (a === "--synth" && argv[i + 1]) {
      synth = argv[++i] === "regenerate" ? "regenerate" : "render";
      continue;
    }
    if (a === "--max-retries" && argv[i + 1]) {
      const n = parseInt(argv[++i], 10);
      if (Number.isFinite(n) && n >= 0) maxRetries = n;
      continue;
    }
    if (a === "--tau" && argv[i + 1]) {
      const n = parseFloat(argv[++i]);
      if (Number.isFinite(n) && n >= 0 && n <= 1) tau = n;
      continue;
    }
    if (path === undefined && !a.startsWith("--")) path = a;
  }
  return {
    lang,
    synth,
    maxRetries,
    noRevise: argv.includes("--no-revise"),
    noGate: argv.includes("--no-gate"),
    coreOnly: argv.includes("--core-only"),
    dryRun: argv.includes("--dry-run"),
    tau,
    path,
  };
}

// Create an empty temp file with a .md extension and return its path. The result
// is written here instead of stdout so the caller gets a real .md artifact
// (openable, diffable) and stdout carries only the path + footer.
function tempMdPath(): string {
  return execFileSync("mktemp", ["--suffix=.md"], { encoding: "utf8" }).trim();
}

export async function main() {
  // The first positional `render` selects prose-render mode (the inverse flow);
  // it is sliced off before flag parsing so the next token is the input path.
  const rawArgv = process.argv.slice(2);
  const mode: "compress" | "render" = rawArgv[0] === "render" ? "render" : "compress";
  const {
    lang,
    synth,
    maxRetries,
    noRevise,
    noGate,
    coreOnly,
    dryRun,
    tau,
    path: inputPath,
  } = parseArgs(mode === "render" ? rawArgv.slice(1) : rawArgv);
  // --dry-run (Backlog 9): the deterministic front half only — segment → per-section
  // payload density → route. Prints the report and returns, writing nothing, making no
  // LLM call, needing no API key. Runs on the note body (frontmatter stripped).
  if (dryRun) {
    const input = readFileSync(inputPath ?? 0, "utf8");
    const { body } = parseFrontmatter(input);
    process.stdout.write(formatDryRun(inputPath ?? "(stdin)", routeNote(body, tau)) + "\n");
    return;
  }
  if (!process.env.FIREWORKS_API_KEY) {
    console.error(
      "FIREWORKS_API_KEY not set (run under: doppler run --project claude-code --config std --)",
    );
    process.exit(1);
  }
  const input = readFileSync(inputPath ?? 0, "utf8");
  if (!input.trim()) process.exit(0);
  const path = tempMdPath();
  const emit = (body: string, footer: string): void => {
    writeFileSync(path, body);
    process.stdout.write(`${path}\n${footer}\n`);
  };
  if (mode === "render") {
    await runRender(input, { lang, noRevise }, emit);
    return;
  }
  // compress mode: strip leading frontmatter (it passes through verbatim; the
  // pipeline + language detection operate on the body only). A block whose YAML
  // failed to parse is flagged (not demoted to body) so it is surfaced in the
  // footer rather than silently reworded as prose.
  const { front, body, error: fmError } = parseFrontmatter(input);
  if (!body.trim()) {
    emit(input, "— no body to distill");
    process.exit(0);
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
  // wikilink to); empty when reading from stdin, where distill() falls back to the H1.
  const selfSlug = inputPath ? slugSegment(basename(inputPath).replace(/\.md$/, "")) : "";
  try {
    const { out, footer, residue } = await distill(
      body,
      resolved,
      frontDescription,
      { synth, maxRetries, noRevise, noGate, coreOnly, isReference, factsDump, tau },
      selfSlug,
    );
    // <result> wraps exactly the text to write back to source: frontmatter
    // (verbatim except the injected epistemic_status default) + distilled body.
    // <residue> carries one <entry> per definition that failed the gate, with
    // verbatim <source>; omitted when empty.
    const front2 = ensureEpistemicStatus(front);
    const result = front2 ? front2 + "\n" + out : out;
    let fileBody = `<result>\n${result}\n</result>\n`;
    if (residue.length) {
      const entries = residue
        .map(
          (r) =>
            `<entry term="${escAttr(r.term)}" reason="${escAttr(r.reason)}">\n<source>\n${r.source}\n</source>\n</entry>`,
        )
        .join("\n");
      fileBody += `\n<residue>\n${entries}\n</residue>\n`;
    }
    const footer2 = fmError
      ? `${footer} · frontmatter not parsed (kept verbatim): ${fmError.slice(0, 80)}`
      : footer;
    emit(fileBody, footer2);
  } catch (e) {
    // A non-transient throw is a real bug — surface it (a stage catch has already
    // logged it on its way up; anything thrown outside a stage prints its own stack
    // on propagation) instead of shipping the original as a silent passthrough.
    // a truncation in a NO-CATCH core stage (extractCombo, gradeBlocks) is not a
    // transient flake and not a code bug: it skips THIS note with a clear actionable
    // footer (raise the stage's cap), never a raw stack crash or a "transient" label.
    if (e instanceof TruncationError) {
      emit(input, `— distill skipped: output TRUNCATED — ${e.message}`);
      process.exit(0);
    }
    if (!isTransient(e)) throw e;
    // transient failsafe: temp file holds the original (passthrough); path still printed
    emit(input, `— distill skipped (error): ${String(e).slice(0, 160)}`);
    process.exit(0);
  }
}
