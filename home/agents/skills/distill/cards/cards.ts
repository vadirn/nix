// cards — pure card-extraction layer: enumerate candidates from a distilled note's
// glossary/tie, validate untrusted band-judge replies, annotate relations against
// REL_REGISTRY, and assemble the staging record. Zero I/O, zero LLM calls (W2 brief).
//
// Boundary rules this module upholds:
//   D13  — never imports pipeline.ts. Callers hand in already-parsed GlossEntry[]
//          and frontmatter fields; this layer never reads a file or spawns a process.
//   D22  — decideCard/buildStagingRecord treat the band verdict as an ANNOTATION.
//          enumerateCandidates never filters on it — every candidate is staged.
import { REL_REGISTRY, type GlossEntry, type Relation } from "../text.ts";
import type { NameLintResult } from "../writing/name-lint.ts";
import type {
  Band,
  BandJudgeReply,
  BandVerdict,
  Candidate,
  CandidateFlag,
  NeighbourHit,
  StagedEdge,
  StagingRecord,
} from "./types.ts";

const BANDS: readonly Band[] = ["defer-link", "mint", "work-through"];

// One concept-arm candidate per glossary entry, term/def/relations carried
// verbatim, plus one thesis-arm candidate when `tie` is non-empty (term = title,
// def = tie, relations = [] — the tie is prose, not a Relations-block source).
// Never filters: every entry becomes a candidate regardless of content (D22 applies
// downstream at staging, but enumeration itself has no admission logic at all).
export function enumerateCandidates(
  entries: GlossEntry[],
  meta: { tie: string | null; title: string; sourceNote: string },
): Candidate[] {
  const out: Candidate[] = entries.map((e) => ({
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
// is a review flag, not an error (D32, open vocabulary) — every relation is kept.
export function annotateEdges(relations: Relation[]): StagedEdge[] {
  return relations.map((r) => ({ ...r, offRegistry: !REL_REGISTRY.includes(r.rel) }));
}

// Assemble one StagingRecord, deriving `edges` from `candidate.relations` via
// annotateEdges. Enforces the frozen invariant (types.ts:72): verdict is null
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
