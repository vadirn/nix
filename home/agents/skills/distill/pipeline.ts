// pipeline — the orchestration layer: the five-stage compress pipeline (distill),
// arg parsing, the temp-file sink, and main(). Sequences the stages from prompts.ts
// behind the seams the leaf modules stabilize; main() is invoked by the entrypoint.
import { existsSync, linkSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
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
  extractGraph,
  fidelityGate,
  gradeBlocks,
  type ProseVerdict,
  proseGate,
  sourceTextFor,
  workflowGate,
} from "./prompts.ts";
import { formatNameLint, nameLintAgainstSource, type NameLintResult } from "./writing/name-lint.ts";
import { locateGraph, payloadKey } from "./locate-graph.ts";
import { projectMarkdown, type Projection } from "./project.ts";
import { computeSource, type Unit } from "./graph.ts";
import { locate } from "./locate.ts";
import { sliceBytes } from "./mdstruct.ts";

// Escape the three characters an XML attribute value cannot carry raw. The passthrough envelope
// (main(), the exit-3 legacy sink) stamps residue labels/reasons into `<entry term=… reason=…>`.
const escAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
import { runProse } from "./prose-mode.ts";
import { buildIntermediary } from "./triage.ts";
import { runApply } from "./apply-mode.ts";
import { parseInteract, renderBlock } from "./interact.ts";
import { applyTyping, buildTypingReview } from "./retype.ts";
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
// Every compress path now projects the canonical seven-section graph, which carries its own
// `type/source/schema` frontmatter, so `out` is always self-provenanced; main() takes it verbatim
// (no source-front prepend). A passthrough return carries the unmodified source body instead.
type DistillResult = {
  out: string;
  footer: string;
  residue: Residue[];
  status: DistillStatus;
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

// The DEMOTED fidelity gate for the canonical pipeline (blueprint §4.2). The retired settle-chain
// gate authored defs/steps and repaired them in a recovery loop against a scratch render; once
// extract emits the FINAL statements there is nothing to repair, so only the gate's VERDICT half
// survives here. It runs AFTER projectMarkdown, takes the projection body itself as judge input, and
// surfaces residue only — no recovery, no in-place mutation, no carriers. Each concept/procedure
// unit's `sourceText` is the verbatim bytes its span locates (the anti-hallucination anchor
// `locateGraph` already resolved), so the concept/workflow judges compare projection ↔ source with
// no legacy shape. Rides the `--no-gate` switch.
async function runFidelityBackstop(
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
  // sourceText the lead-step slice (per-step spans are deferred — blueprint §8 gap #1).
  const groups = result.units
    .filter((u) => u.type === "procedure")
    .map((u) => ({
      id: u.id,
      steps: u.statement.split("\n").filter((s) => s.trim().length > 0),
      sourceText: sliceBytes(buf, u.span),
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
    const inconclusive = c.grade === "inconclusive";
    residue.push({
      label: c.term,
      reason: inconclusive
        ? `gate-inconclusive: ${c.missing || "judge returned no verdict"}`
        : `${c.direction || "residue"}: ${c.missing || "failed round-trip entailment"}`,
      source: concepts.find((r) => r.term === c.term)?.sourceText ?? "",
      kind: "def",
      reasonClass: inconclusive ? "gate-inconclusive" : "failed",
    });
  }
  for (const v of gradedG) {
    if (v.grade === "translated") continue;
    const inconclusive = v.grade === "inconclusive";
    residue.push({
      label: v.id,
      reason: inconclusive
        ? `gate-inconclusive: ${v.missing || "judge returned no verdict"}`
        : `workflow: ${v.missing || "directive coverage failed"}`,
      source: groups.find((g) => g.id === v.id)?.sourceText ?? "",
      kind: "steps",
      reasonClass: inconclusive ? "gate-inconclusive" : "failed",
      // per-step spans are deferred, so the canonical backstop carries no flat-list indices.
      stepIdxs: [],
    });
  }
  const gateSkipped =
    graded.concepts.filter((c) => c.grade === "inconclusive").length +
    gradedG.filter((v) => v.grade === "inconclusive").length;
  return { residue, gateSkipped };
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

// The deterministic payload-residue backstop for a canonical projection: dropped payload spans
// (payloadResidue), surfaced for rollback (D16). Both distill (homogeneous build) and
// assembleRoutedNote (the routed whole-note run) call THIS over (source, projected out) so a span
// surviving anywhere in output reads as covered. The wikilink lane is INTENTIONALLY omitted: every
// path now projects the canonical graph, whose `## Relations` renders local edges as plain
// headwords and whose locate stage drops every cross-note `[[wikilink]]` endpoint (only local units
// become edges), so a wikilink lane would mass-flag every source wikilink as dropped. Cross-note
// edges stay dropped by locked scope; wikilinkResidue survives as a standalone tested primitive
// (its own suite), just no longer wired here. (Carrying cross-note edges via external endpoints is
// Backlog.)
export function edgePayloadResidue(text: string, out: string): Residue[] {
  return payloadResidue(text, out);
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

// The canonical compress core (blueprint §0): extract native typed units → retain-grade the
// payload lane → locate spans (hard-gate). Returns the span-anchored graph (`result`), the
// pre-graph (`pre`, for the backstop's thesis + section counts), and the retain-graded
// `payloadBlocks`, or null when nothing distills (no unit of any type → passthrough). `bodyForSpans`
// is the text every unit/edge span indexes into: the whole source for both the homogeneous run and
// the routed head (so a routed head's spans index the reassembled source, blueprint §6.3). Reused by
// distill() (default/--glossary/--reference) and distillRouted() (the re-authored head).
async function compressToGraph(
  blocks: Block[],
  bodyForSpans: string,
  path: string,
  frontDescription: string,
  lang: "en" | "ru",
  selfSlug: string,
  linkInventory: LinkInventory,
  opts: { progress?: (line: string) => void },
): Promise<{
  pre: Awaited<ReturnType<typeof extractGraph>>;
  result: Projection;
  payloadBlocks: Block[];
} | null> {
  opts.progress?.("extract…");
  const pre = await extractGraph(blocks, frontDescription, lang, linkInventory, selfSlug);
  if (
    pre.concepts.length === 0 &&
    pre.judgements.length === 0 &&
    pre.inferences.length === 0 &&
    pre.procedures.length === 0
  ) {
    return null;
  }
  // payload retain lane (blueprint §1.1) — the ONE deterministic selection surviving the settle-chain
  // collapse. statement = block.text (verbatim), so its locate can never fail. Units render in
  // extract-emission order (the ordering role dies).
  opts.progress?.("grade…");
  const grades = await gradeBlocks(
    pre.thesis,
    pre.concepts.map((c) => ({ term: c.id ?? "", def: c.statement })),
    blocks,
  );
  const payloadBlocks = blocks.filter((b) => grades.get(b.id) === "retain");
  // locate: pre-graph → span-anchored graph. A bad quote HARD-ABORTS here (spec §2), before any
  // projection — the earliest possible surfacing.
  const result = locateGraph(pre, path, bodyForSpans, payloadBlocks);
  return { pre, result, payloadBlocks };
}

// orchestrator: thread the canonical stages (extract → locate → project → backstop). Routes a
// payload-dense note to distillRouted first; otherwise runs the homogeneous canonical pipeline.
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
    // The source file path recorded in the canonical projection's `source:` frontmatter (read on
    // the default-compress path — the seven-section projection). Undefined for stdin.
    path?: string;
    progress?: (line: string) => void;
  },
  selfSlug = "",
): Promise<DistillResult> {
  // Per-section render-router (D12/D16, Backlog 10). When a note carries any payload-dense section,
  // route: re-author the idea sections into ONE compact head graph, hold the payload sections
  // verbatim as `## Payload` units, and project the merged graph as one canonical note
  // (distillRouted). --glossary bypasses routing (it wants the flat structured extract).
  if (!opts.glossaryOnly) {
    const { title, sections } = partition(text, opts.tau);
    if (sections.some((u) => u.route === "preserve")) {
      return distillRouted(text, title, sections, lang, frontDescription, opts, selfSlug);
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

  // Every compress run — default, --glossary, --reference — is the canonical graph-native pipeline:
  // extract native typed units → locate (span hard-gate) → project. --glossary omits the synthesized
  // `## Abstract` head (§6.1); --reference keeps it but suppresses `## Relations` (§6.2, D30 —
  // reference notes stay link-free); every other section renders identically. The deterministic link
  // inventory (every vault edge — [[wikilink]] or scheme-less [text](path) — UNION every external
  // [text](url)) feeds the extractor as a MUST-COVER checklist.
  const linkInventory: LinkInventory = {
    wikilinks: harvestVaultEdges(text),
    external: harvestExternalLinks(text),
  };

  // 1. extract the typed idea-graph (native FINAL statements + per-unit quotes) and 2. locate the
  // spans against the source — a bad quote HARD-ABORTS in locate, BEFORE any projection (spec §2).
  // Nothing to distill (no unit of any type) → passthrough.
  const core = await compressToGraph(
    blocks,
    text,
    opts.path ?? "",
    frontDescription,
    lang,
    effectiveSelfSlug,
    linkInventory,
    opts,
  );
  if (!core) {
    return {
      out: text,
      footer: `— nothing to distill · ${beforeWords} words`,
      residue: [],
      status: "passthrough",
    };
  }
  const { pre, result, payloadBlocks } = core;

  // 2b. span-typing review (spec §4 step 3; blueprint §11): the one place semantic taste re-enters
  // the otherwise-deterministic pipeline — the reviewer confirms each unit's type against its
  // resolved source slice and re-types where wrong, mutating result.units IN PLACE before projection
  // (projectMarkdown re-buckets purely on unit.type via byType, so setting the field is the whole
  // operation). TTY-gated exactly like the residue-triage session below: when EITHER stream is
  // non-TTY (piped, redirected, the test harness, agent callers) the review is skipped and the graph
  // keeps its extract-assigned types, so the default non-interactive pipeline stays
  // extract→locate→project and is byte-identical.
  if (process.stdin.isTTY && process.stdout.isTTY) {
    opts.progress?.("type…");
    await runTypingReview(result, text);
  }

  // 3. project the seven-section canonical markdown (carries its own frontmatter). --glossary drops
  // the `## Abstract` head (`Projection.abstract` is optional, so omitting it suppresses the one
  // unanchored block); --reference keeps `## Abstract` but suppresses `## Relations` via the
  // projector's relations opt.
  let out: string;
  if (opts.isReference) {
    out = projectMarkdown(result, { relations: false });
  } else {
    out = projectMarkdown(opts.glossaryOnly ? { ...result, abstract: undefined } : result);
  }

  // 4. demoted fidelity backstop over the projection (residue-only, no recovery; blueprint §4.2).
  let residue: Residue[] = [];
  let gateSkipped = 0;
  if (!opts.noGate) {
    opts.progress?.("gate…");
    const bs = await runFidelityBackstop(pre.thesis, result, out, text, lang);
    residue = bs.residue;
    gateSkipped = bs.gateSkipped;
  }
  const entriesCount = pre.concepts.length;
  const stepsCount = pre.procedures.reduce((n, p) => n + p.steps.length, 0);

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
  // list-items under a heading — the must-cover prose class the spine is blind to. An LLM call, so
  // it rides --no-gate; skipped in --glossary (no prose body) and on facts/context dumps (wholesale
  // drop is licensed there, so the inventory would only flood the footer). The canonical projection
  // carries no exclusion set, so the matcher judges every source list-item against the projection
  // body (a broad backstop). Appends to residue only.
  if (!opts.noGate && !opts.glossaryOnly && !opts.factsDump) {
    const units = harvestProseListItems(text, []);
    opts.progress?.("prose-gate…");
    residue = residue.concat(await runProseGate(units, out, lang));
  }

  // deterministic payload-coverage backstop: surface any source payload span the projection dropped
  // (edgePayloadResidue; the wikilink lane is off — the canonical projection drops cross-note edges
  // by design, so a wikilink lane would false-flag every source wikilink). Free, so it runs even
  // under --no-gate — dropped payload is irreversible loss the fidelity backstop never checks.
  residue = residue.concat(edgePayloadResidue(text, out));
  // deterministic, zero-LLM, never blocks — findings go to the footer only, never into residue.
  const nameLint = nameLintAgainstSource(out, text);
  const footer = buildFooter({
    beforeWords,
    afterWords,
    entries: entriesCount,
    steps: stepsCount,
    verbatim: payloadBlocks.length,
    residue: residue.length,
    gateSkipped,
    keptVerbatim: 0,
    retries: 0,
    proseFixes: 0,
    glossaryOnly: opts.glossaryOnly,
    // the prose gate is in scope (!noGate && !glossaryOnly) but the facts-dump genre gate
    // skipped it above — flag the disabled loss detector instead of dropping it silently.
    proseGateOffFactsDump: !opts.noGate && !opts.glossaryOnly && opts.factsDump,
    nameLint,
  });
  return { out, footer, residue, status: "compressed" };
}

// The heterogeneous (per-section-routed) build (D12/D16, Backlog 10; blueprint §6.3). Re-author the
// idea sections as ONE head graph — a canonical extract→locate of their concatenation, whose spans
// index the WHOLE source — then hold the payload sections verbatim as `## Payload` units and project
// the merged graph as one canonical note. The whole-note expand guard is intentionally NOT applied:
// the preserve sections are held verbatim and cannot shrink, so a whole-note size compare would
// no-op the route on its target class. The head's own LLM fidelity gate is dropped (the deterministic
// payload-coverage backstop, re-run at whole-note scope in assembleRoutedNote, is its residue floor).
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
  const effectiveSelfSlug = selfSlug || slugSegment(title.replace(/^#+\s*/, ""));
  const linkInventory: LinkInventory = {
    wikilinks: harvestVaultEdges(text),
    external: harvestExternalLinks(text),
  };
  // The re-authored head becomes a span-anchored graph via extract→locate of reauthorText, with
  // spans located against the WHOLE source (blueprint §6.3). null = the head distilled to nothing
  // (its prose is then held verbatim as payload by assembleRoutedNote).
  const core = reauthorText
    ? await compressToGraph(
        segment(reauthorText),
        text,
        opts.path ?? "",
        frontDescription,
        lang,
        effectiveSelfSlug,
        linkInventory,
        opts,
      )
    : null;
  // The routed note is itself a compression (prose re-authored, payload held verbatim); its own
  // status is "compressed".
  return {
    ...assembleRoutedNote({
      source: text,
      path: opts.path ?? "",
      title,
      head: core?.result ?? null,
      headVerbatim: reauthorText !== "" && core === null,
      sections,
    }),
    status: "compressed",
  };
}

// Pure seam of the per-section routed build (the no-LLM tail of distillRouted; blueprint §6.3):
// merge the re-authored head graph with the preserve sections (each held verbatim as a `## Payload`
// unit whose span locates the section text in the WHOLE source), project the merged graph as one
// canonical note, re-run the deterministic payload-coverage backstop ONCE at whole-note scope, and
// build the footer. No model and no I/O, so distillRouted's wiring is unit-testable in pure.test.ts.
//
// Payload units are appended in source order (walking `sections`); when the head is null (verbatim
// — extract found nothing to distill), the re-author sections are ALSO held verbatim as payload, so
// no prose is lost. The head's concept/judgement/inference/procedure units and edges ride straight
// into the merged graph; projectMarkdown renders them under their canonical sections, so the note is
// a standard seven-section projection (a deliberate change from the legacy head-first interleave).
export function assembleRoutedNote(a: {
  source: string;
  path: string;
  title: string;
  head: Projection | null;
  headVerbatim: boolean;
  sections: { route: Route; text: string }[];
}): { out: string; footer: string; residue: Residue[] } {
  const beforeWords = wordCount(a.source);
  const units: Unit[] = a.head ? [...a.head.units] : [];
  const edges = a.head?.edges ?? [];
  // Every preserve section — plus, when the head is verbatim, every re-author section — is held
  // byte-verbatim as a `## Payload` unit, spanning the whole source (compactSection v1 = identity).
  let payloadN = units.filter((u) => u.type === "payload").length;
  for (const u of a.sections) {
    const holdVerbatim = u.route === "preserve" || (!a.head && u.route === "re-author");
    if (!holdVerbatim) continue;
    const slice = compactSection(u.text);
    payloadN++;
    units.push({
      id: payloadKey(slice, payloadN),
      type: "payload",
      statement: slice,
      span: locate(a.source, slice),
    });
  }
  const source = a.head?.source ?? computeSource(a.path, a.source);
  const title = a.title.replace(/^#+\s*/, "").trim() || a.head?.title;
  const out = projectMarkdown({ source, units, edges, title, abstract: a.head?.abstract });
  const afterWords = wordCount(out);
  const residue = edgePayloadResidue(a.source, out);
  const reCount = a.sections.filter((u) => u.route === "re-author").length;
  const preserveCount = a.sections.length - reCount;
  // deterministic, zero-LLM, never blocks — assembleRoutedNote owns the one whole-note check.
  const nameLint = nameLintAgainstSource(out, a.source);
  const footer =
    `— per-section route: ${reCount} re-author / ${preserveCount} preserve` +
    ` · ${beforeWords}→${afterWords} words` +
    (a.headVerbatim ? " · head kept verbatim (prose not compressed)" : "") +
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
  --glossary            emit the structured extract with the ## Abstract head omitted
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

/// The span-typing review's TTY orchestration (blueprint §11.4): the interactive half of the pure
/// retype.ts helpers, driven only at a real terminal (the caller in distill() TTY-gates it, so a
/// non-TTY run never reaches here — the review is skipped and the graph keeps its extract-assigned
/// types). Writes the per-unit `pick-one` review (buildTypingReview → renderBlock) to a scratch file,
/// then runs the SAME gate-aware sugar loop as runTtySession: re-read on each iteration, prompt until
/// the confirm-all gate is checked (the reviewer toggles types + the gate in their editor), then
/// applyTyping the result — mutating result.units IN PLACE before the caller projects. A non-"y"
/// answer or EOF declines: the graph is left with its extract-assigned types. `askFn` is the same
/// injection seam runTtySession uses; production wires the real `ask`. The scratch file is always
/// removed. Returns true when the reviewer confirmed (types applied), false when they declined.
export async function runTypingReview(
  result: Projection,
  body: string,
  askFn: (prompt: string) => Promise<string | null> = ask,
): Promise<boolean> {
  const blocks = buildTypingReview(result, body);
  if (blocks.length === 0) return false; // no units → nothing to type
  const scratch = join(tmpdir(), `distill-typing-${process.pid}-${Date.now()}.md`);
  writeFileSync(scratch, blocks.map(renderBlock).join(""));
  try {
    for (;;) {
      const text = readFileSync(scratch, "utf8");
      const { blocks: parsed } = parseInteract(text);
      const gate = parsed.find((b) => b.kind === "confirm-all");
      const gateChecked =
        gate !== undefined &&
        gate.items.length > 0 &&
        gate.items.every((it) => it.state === "checked");
      if (!gateChecked) {
        const answer = await askFn(
          `typing review '${scratch}' — set each unit's type, check the gate, then press y [y/N] `,
        );
        if (!isYes(answer)) return false;
        continue; // re-read before applying — the tick is the file's, not the terminal's
      }
      applyTyping(result, text);
      return true;
    }
  } finally {
    try {
      unlinkSync(scratch);
    } catch {}
  }
}

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
        path: inputPath,
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
    // ONE frontmatter block. Every compress path now projects the canonical graph, whose `out`
    // already carries its own `type: distillation` / `source:` / `schema:` YAML, so main() takes it
    // verbatim — prepending the source note's `front` would emit two YAML blocks. buildIntermediary
    // then stamps `epistemic_status: in-review` into that single block. Source-note-only fields
    // (aliases/tags/description) drop with the source front — a distillation is a derived artifact
    // stamped with its own provenance (Backlog).
    const noteForIntermediary = out;
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
