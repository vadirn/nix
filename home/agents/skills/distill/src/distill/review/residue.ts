// residue — the deterministic loss-surface primitives carved out of distill-core.ts.
// Pure functions over (source, output) text plus the judge-verdict mapping: they compute
// what a distillation dropped, never recover it. No I/O, no model call, no CLI state — so
// they are unit-tested directly (pure.test.ts, stages.test.ts) and the pipeline's gate
// runners (runFidelityBackstop, runProseGate) import them.
import {
  type PayloadSpan,
  type ProseUnit,
  harvestBlockquotes,
  harvestCitations,
  harvestFences,
  harvestImages,
  harvestMath,
  harvestNumbers,
  harvestTableRows,
  harvestVaultEdges,
  normalizeForContainment,
} from "@/distill/extract/harvest.ts";
import { type ProseVerdict } from "@/distill/prompt/prompts.ts";

// What failed and where, carried structurally (not re-derived from the reason string) so
// triage.ts's residueToBlocks can pick the decision verb and target per entry straight off
// `kind` and `stepIdxs`.
export type ResidueKind = "def" | "steps" | "thesis" | "edge" | "payload" | "prose";
// Why the item is residue: "failed" — a gate judged it unfaithful (def/steps/thesis);
// "gate-inconclusive" — the fidelity/workflow judge returned no verdict, so the entry
// SHIPPED in the body surfaced-but-unverified (the one class triage maps to `keep:`);
// "dropped" — a coverage lane found it absent from output (incl. the wikilink
// slug-collision "verify manually" case, whose recover semantics match a drop's);
// "prose-inconclusive" — the coverage judge returned no usable verdict for an item
// that is NOT known to be in the body, so it triages as recover, not keep.
export type ResidueClass = "failed" | "gate-inconclusive" | "dropped" | "prose-inconclusive";
// One residue entry: what was lost (`source`), why (`reason`/`reasonClass`), and what kind of
// unit it came from (`kind`). wikilinkResidue, payloadResidue, and proseResidue each produce
// these for triage.ts to render.
export type Residue = {
  label: string;
  reason: string;
  source: string;
  kind: ResidueKind;
  reasonClass: ResidueClass;
  /// 0-based indices into the flat step list under the emitted `## Procedures`
  /// entry; set iff kind === "steps". Per-step spans are deferred — the field stays typed
  /// for a future per-step-span backstop, but the canonical backstop (runFidelityBackstop)
  /// always emits an empty array here today.
  stepIdxs?: number[];
};

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
// positive. The projection's `[[file-slug]]` relation endpoints carry no fragment, so the
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
// (payloadResidue), surfaced for rollback rather than silently dropped. Both distill
// (homogeneous build) and assembleRoutedNote (the routed whole-note run) call THIS over (source,
// projected out) so a span surviving anywhere in output reads as covered. The wikilink lane is
// INTENTIONALLY omitted: every
// path now projects the canonical graph, whose `## Relations` renders local edges as plain
// headwords and whose locate stage drops every cross-note `[[wikilink]]` endpoint (only local units
// become edges), so a wikilink lane would mass-flag every source wikilink as dropped. Cross-note
// edges stay dropped by locked scope; wikilinkResidue survives as a standalone tested primitive
// (its own suite), just no longer wired here. (Carrying cross-note edges via external endpoints is
// Backlog.)
export function edgePayloadResidue(text: string, out: string): Residue[] {
  return payloadResidue(text, out);
}

// ---- prose-list-item gate (the prose-judge tier): the pure verdict→residue mapping ----
// The deterministic spine above catches dropped literal/structural payload; this mapping catches
// a dropped pure-prose list-item, the must-cover class the spine AND the fidelity/workflow
// gates are all blind to. harvest.ts::harvestProseListItems is the deterministic answer key;
// prompts.ts::proseGate (glm, the model that did not write the compression) is the matcher (wired
// in gates.ts::runProseGate); the covered→clear decision is made HERE — surfaced is the DEFAULT
// for every outcome except an explicit covered verdict whose anchor is verified present and on-topic.

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
