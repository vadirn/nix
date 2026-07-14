// cards/types.ts — frozen contracts for the card-extraction layer. Every cards/ module
// builds against these shapes; the build agents may not widen them.
//
// Boundary rules the shapes encode:
//   - This layer reads an EMITTED distilled note — a .md file path is the handshake — and
//     never calls distill() or imports distill-core.ts.
//   - The band verdict is an ANNOTATION a candidate carries into staging, never a filter:
//     every candidate is staged regardless of its verdict.
//   - The only path from a staging file into `20 cards/` is a human commit; a staging
//     file's draft exists to be rewritten by that human, never to be accepted as-is.

import type { NameLintResult } from "@/core/writing/name-lint.ts";

// One structural edge harvested from an emitted note's `## Relations` block and attached
// to its owning concept (the from-label's slug), stripped of the from-field. `rel` an open
// hyphenated token, `to` an endpoint (bare local term-slug or a [[file-slug]] wikilink),
// `predicate` an optional one-clause gloss. UNCERTIFIED — parsed off the source, never
// re-verified.
export type CardEdge = { rel: string; to: string; predicate: string | null };

// One concept harvested from an emitted note for card enumeration: the `### headword`
// term, its first-line def (both from the canonical `## Concepts` reader), and the
// `## Relations` edges attached to it. The input shape enumerateCandidates maps to a
// concept-arm Candidate.
export type HarvestedConcept = { term: string; def: string; relations: CardEdge[] };

// Which lexicographer form the draft takes. v1 ships two arms; inference is
// excluded by the vault typology (its surface is prose, governed by validity —
// an inference-shaped span re-types to its CONCLUSION as a thesis candidate).
export type Arm = "concept" | "thesis";

// One prospective card enumerated from a distilled note. concept arm: one per
// `## Concepts` entry. thesis arm: at most one per note, from the frontmatter
// description (the certified tie). Enumeration never filters.
export type Candidate = {
  arm: Arm;
  term: string; // headword: the concept headword (concept) / the note's H1 or title (thesis)
  def: string; // certified content: the concept def (concept) / the tie text (thesis)
  relations: CardEdge[]; // edges parsed from `## Relations` for this term — UNCERTIFIED channel
  sourceNote: string; // absolute path of the emitted note the candidate came from
};

// One existing vault card surfaced by recall (BM25 via vault-query today; the
// seam is recall-agnostic so an embedding swap changes nothing downstream).
// `description` comes from the card's frontmatter, "" when it has none — the
// judge then falls back on `snippet`.
export type NeighbourHit = {
  path: string; // vault-relative, as vault-query reports it
  title: string;
  score: number;
  description: string;
  snippet: string;
};

// The three admission bands (typology: "Admission is a band, not a threshold").
//   defer-link   — distance ≈ 0, recognized: link to the existing card, don't mint.
//   mint         — productive middle band: new card, edged to the neighbours it hooked.
//   work-through — too far, not yet a clean node: develop the concept before minting.
export type Band = "defer-link" | "mint" | "work-through";

// The band judge's verdict. Annotation only — it never gates or filters a candidate;
// `nearest` is what the judge actually saw, best first, so review can audit the call.
export type BandVerdict = {
  band: Band;
  rationale: string; // one clause
  nearest: NeighbourHit[];
};

// Failure lanes — surface, never silent (the fw.ts discipline extended to the
// CLI's first non-LLM side effects):
//   recall-unavailable — the vault-query spawn failed; candidate staged anyway,
//     flagged, with zero neighbours.
//   judge-inconclusive — the band judge returned no parseable verdict; staged,
//     flagged (mirrors the pipeline's gate-inconclusive lane).
//   draft-failed — the draft call failed after fw.ts retries; staged with draft "".
export type CandidateFlag = "recall-unavailable" | "judge-inconclusive" | "draft-failed";

// A relation annotated against REL_REGISTRY. Off-registry is a review flag, never an
// error — the relation vocabulary is open, not a closed enum.
export type StagedEdge = CardEdge & { offRegistry: boolean };

// Everything the staging writer renders for one candidate — one file per record.
export type StagingRecord = {
  candidate: Candidate;
  verdict: BandVerdict | null; // null iff flags include "judge-inconclusive"
  edges: StagedEdge[];
  flags: CandidateFlag[];
  lang: "en" | "ru";
  draft: string; // delta-first LLM draft body; "" when drafting failed
  nameLint?: NameLintResult; // deterministic corrupted/invented-name lint of draft vs. body
};

// Raw judge replies (the prompts.ts <-> stage wiring contract; validated by the
// pure layer before anything trusts them).
export type BandJudgeReply = { band: string; rationale: string };
export type DraftReply = { draft: string };
export type AtomicityReply = { atomic: boolean; reason: string };
