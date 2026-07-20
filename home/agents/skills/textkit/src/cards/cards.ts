// cards — pure card-extraction layer: harvest a distilled note's concepts from the
// canonical `## Concepts`/`## Relations` channels, enumerate candidates from them and
// the tie, validate untrusted band-judge replies, annotate relations against
// REL_REGISTRY, and assemble the staging record. Zero I/O, zero LLM calls.
//
// Boundary rules this module upholds:
//   - Never imports distill-core.ts and never calls distill(). Callers hand in an emitted
//     note's body string (harvestConcepts reads its channels); this layer only ever reads
//     that string, never a file, and never spawns a process. Structural channels — the
//     `## Relations` block — are read through one leaf-module seam, text.ts's
//     parseRelationsBlock, imported below.
//   - decideCard/buildStagingRecord treat the band verdict as an ANNOTATION, never a
//     filter: enumerateCandidates never filters on it, so every candidate is staged
//     regardless of its verdict.
import { REL_REGISTRY, slugSegment } from "textkit/core/text.ts";
import { parseCanonicalNote, parseRelationsBlock } from "textkit/distill/emit.ts";
import type { NameLintResult } from "textkit/core/writing/name-lint.ts";
import type {
  Band,
  BandJudgeReply,
  BandVerdict,
  Candidate,
  CandidateFlag,
  CardEdge,
  HarvestedConcept,
  NeighbourHit,
  StagedEdge,
  StagingRecord,
} from "textkit/cards/types.ts";

const BANDS: readonly Band[] = ["defer-link", "mint", "work-through"];

// Harvest an emitted note's concepts for card enumeration: term/def from the canonical
// `## Concepts` reader (`### headword` + first-line def), edges from the `## Relations`
// block attached to the concept whose slug matches each edge's `from` label. A
// single-atom edge (`from === null`) attaches to the sole concept when there is exactly
// one; over zero or many concepts it has no unambiguous owner and is dropped (lossy,
// matches parseRelationsBlock's tolerance). Both sides of the slug comparison are slugged
// so a hand-typed, unslugged from-label — the expected shape when a human edits the
// relations block before committing the card — still resolves to its concept instead of
// silently detaching.
export function harvestConcepts(body: string): HarvestedConcept[] {
  const concepts: HarvestedConcept[] = parseCanonicalNote(body).concepts.map((c) => ({
    term: c.headword,
    def: c.def,
    relations: [],
  }));
  for (const edge of parseRelationsBlock(body)) {
    const rel: CardEdge = { rel: edge.rel, to: edge.to, predicate: edge.predicate };
    if (edge.from !== null) {
      const fromSlug = slugSegment(edge.from);
      concepts.find((c) => slugSegment(c.term) === fromSlug)?.relations.push(rel);
    } else if (concepts.length === 1) {
      concepts[0].relations.push(rel);
    }
    // else: single-atom edge over zero or many concepts has no unambiguous owner — drop.
  }
  return concepts;
}

// One concept-arm candidate per harvested concept, term/def/relations carried
// verbatim, plus one thesis-arm candidate when `tie` is non-empty (term = title,
// def = tie, relations = [] — the tie is prose, not a Relations-block source).
// Never filters: every concept becomes a candidate regardless of content — the band
// verdict is applied downstream at staging, so enumeration itself has no admission
// logic at all.
export function enumerateCandidates(
  concepts: HarvestedConcept[],
  meta: { tie: string | null; title: string; sourceNote: string },
): Candidate[] {
  const out: Candidate[] = concepts.map((e) => ({
    arm: "concept",
    term: e.term,
    def: e.def,
    relations: e.relations,
    sourceNote: meta.sourceNote,
  }));
  if (meta.tie) {
    out.push({
      arm: "thesis",
      term: meta.title,
      def: meta.tie,
      relations: [],
      sourceNote: meta.sourceNote,
    });
  }
  return out;
}

// Validate an untrusted BandJudgeReply into a BandVerdict, or null (the
// judge-inconclusive lane) when it doesn't hold up. `band` normalizes by trim +
// lowercase + whitespace→hyphen (same reason normalizeRelation hyphenates rel
// tokens: "work through" is a judge's plausible surface form of `work-through`,
// not a different verdict) to one of the three admission bands; `rationale` must
// be a non-empty string after trimming. `nearest` passes through untouched —
// recall-agnostic, this layer never inspects or reorders what the caller's
// recall step surfaced.
export function decideCard(reply: unknown, nearest: NeighbourHit[]): BandVerdict | null {
  if (!reply || typeof reply !== "object") return null;
  const r = reply as Partial<BandJudgeReply>;
  if (typeof r.band !== "string" || typeof r.rationale !== "string") return null;
  const band = r.band.trim().toLowerCase().replace(/\s+/g, "-");
  const rationale = r.rationale.trim();
  if (!rationale) return null;
  if (!BANDS.includes(band as Band)) return null;
  return { band: band as Band, rationale, nearest };
}

// Annotate each relation with whether its `rel` token is in REL_REGISTRY. Off-registry
// is a review flag, not an error — the relation vocabulary is open, not a closed set —
// so every relation is kept.
export function annotateEdges(relations: CardEdge[]): StagedEdge[] {
  return relations.map((r) => ({ ...r, offRegistry: !REL_REGISTRY.includes(r.rel) }));
}

// Assemble one StagingRecord, deriving `edges` from `candidate.relations` via
// annotateEdges. Enforces the frozen invariant (types.ts:85): verdict is null
// if-and-only-if flags include "judge-inconclusive". Both directions of the
// biconditional are checked and violation throws — a caller bug, never data to
// tolerate, since the two fields would otherwise silently disagree in staged output.
export function buildStagingRecord(args: {
  candidate: Candidate;
  verdict: BandVerdict | null;
  flags: CandidateFlag[];
  lang: "en" | "ru";
  draft: string;
  nameLint?: NameLintResult;
}): StagingRecord {
  const inconclusive = args.flags.includes("judge-inconclusive");
  if (args.verdict === null && !inconclusive) {
    throw new Error("buildStagingRecord: verdict is null but flags omit judge-inconclusive");
  }
  if (args.verdict !== null && inconclusive) {
    throw new Error("buildStagingRecord: flags include judge-inconclusive but verdict is non-null");
  }
  return {
    candidate: args.candidate,
    verdict: args.verdict,
    edges: annotateEdges(args.candidate.relations),
    flags: args.flags,
    lang: args.lang,
    draft: args.draft,
    nameLint: args.nameLint,
  };
}
