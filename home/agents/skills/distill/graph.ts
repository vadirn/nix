// graph.ts — the canonical distillation graph, distill's source of truth. A `DistillationResult`
// is a typed, span-anchored knowledge graph `{ source, units[], edges[] }` over the five
// knowledge-element types; markdown is one projection of it (spec §1), rendered by project.ts
// and read back by parse-projection.ts. This is a LEAF module: it imports only the `Span`
// byte-offset type from mdstruct.ts so the type contract stays free of the CLI-wrapper's
// runtime dependencies. text.ts's `GlossEntry`/`Relation` shape (the pre-canonical two-channel
// `## Glossary`/`## Relations` grammar) is retained alongside this graph, not superseded by
// it — cards/card-stage.ts still reads emitted notes through that shape (D6).
import { createHash } from "node:crypto";
import type { Span } from "./mdstruct.ts";

// The five knowledge-element types, taxonomy of "Vault as a typed concept graph". `type` is
// carried by WHICH SECTION a unit renders under in the markdown projection, never a `type::`
// field. A payload unit's `statement` IS a verbatim source slice; every other type's statement
// is the normalized standard-form re-expression.
export type UnitType = "concept" | "judgment" | "inference" | "procedure" | "payload";

// Judgment modality, an admission gate on card extraction (spec §3/§6). Applies to judgments
// only; an unmarked judgment is `assertoric`. `hypothesis` = problematic (not minted as an
// asserted card), `necessarily` = apodictic. No extractor emits this yet (design Backlog 5);
// it is on the type now so the prompt can populate it without a shape change.
export type Modality = "hypothesis" | "necessarily" | "assertoric";

// Mirrors mdstruct's Rust `Source` (model.rs:74) — the version-binding record. `bytes` and
// `sha256` are computed over the UTF-8 bytes of the source (see computeSource); `source.sha256`
// records which version a graph's spans index into, so a later divergence fails loudly.
export interface Source {
  path: string;
  bytes: number;
  sha256: string;
}

// One knowledge element. `span` is a half-open UTF-8 byte range into the source bytes (the
// anchor); `modality` is present on judgments only (optional, unmarked = assertoric).
export interface Unit {
  id: string;
  type: UnitType;
  statement: string;
  span: Span;
  modality?: Modality;
}

// One structural edge between two units. `rel` is an open-registry hyphenated token (validated
// against REL_REGISTRY in text.ts, the source of truth — not re-declared here). `span` anchors
// the edge to the source bytes the relation was distilled from.
export interface Edge {
  from: string;
  to: string;
  rel: string;
  span: Span;
}

// The canonical distillation graph — the IR that is the source of truth; markdown is a
// projection of it.
export interface DistillationResult {
  source: Source;
  units: Unit[];
  edges: Edge[];
}

// ---- the pre-graph: extract's output BEFORE locate (spec §4 step 1; blueprint §1.4) ----
// The model emits typed units carrying their verbatim `quote` but NO `span` — tooling computes
// spans at the locate stage, never the model (that is the anti-hallucination primitive). A
// `PreGraph` is what `parseExtractGraph` returns and what `locateGraph` consumes to produce the
// span-anchored `DistillationResult`. `statement` is already the FINAL normalized re-expression
// (concept def / judgement / inference / joined procedure steps), not a draft the settle chain
// rewrites. These types sit here so both the parse (prompts.ts) and locate (locate-graph.ts)
// stages read one leaf; adding them keeps graph.ts a leaf (they use only local UnitType/Modality).
export interface PreUnit {
  type: UnitType;
  // present for concepts (the headword id); judgement/inference ids are ordinal, assigned at
  // locate (J1../I1..); a procedure's headword rides on its group, not the step PreUnit.
  id?: string;
  statement: string;
  quote: string;
  modality?: Modality;
  // per-bullet division-list spans are deferred (blueprint §8 gap #1 / §10 item 3); the first
  // cut emits statement-only concepts, so `bullets` stays unpopulated.
  bullets?: { statement: string; quote: string }[];
}

// One pre-locate edge. `fromHeadword` is the owning concept's headword (its unit id at locate);
// `predicate` is dropped (the projection never renders it — blueprint §1.2). `quote` is the
// verbatim source slice the relation was distilled from (the span-locate anchor).
export interface PreEdge {
  fromHeadword: string;
  rel: string;
  to: string;
  quote: string;
}

// The whole pre-locate extract: document-level orientation (title/abstract/description/thesis)
// plus the four re-expressed type channels and the flat edge list. Payload is NOT a channel — it
// is a deterministic post-extract lane from retain-grading (blueprint §1.1), folded in at locate.
export interface PreGraph {
  title: string;
  abstract: string;
  description: string;
  thesis: string;
  concepts: PreUnit[];
  judgements: PreUnit[];
  inferences: PreUnit[];
  procedures: { headword: string; steps: PreUnit[] }[];
  edges: PreEdge[];
}

// Render a span as the bare trailing-anchor notation `start..end` (spec §2/§3). The bracketed
// form is an accepted INPUT (parseSpan reads both); emit is always bare to match the projection.
export function formatSpan(span: Span): string {
  return `${span[0]}..${span[1]}`;
}

// Parse the `start..end` anchor notation into a Span. Accepts both the bare `start..end` and the
// bracketed `[start..end]` forms — both read to the same half-open range (spec §2). Brackets must
// be balanced; anything else throws (a hard parse failure, never a sentinel).
export function parseSpan(str: string): Span {
  const m = str.trim().match(/^(?:\[(\d+)\.\.(\d+)\]|(\d+)\.\.(\d+))$/);
  if (!m) {
    throw new Error(
      `parseSpan: not a byte-span anchor: ${JSON.stringify(str)} (expected "start..end" or "[start..end]")`,
    );
  }
  const start = Number(m[1] ?? m[3]);
  const end = Number(m[2] ?? m[4]);
  return [start, end];
}

// Compute a `Source` in TS over the UTF-8 bytes of `text`: `bytes` is the UTF-8 byte length and
// `sha256` is the hex sha256 of those same bytes, TRUNCATED to the first 12 hex digits (48 bits)
// to match the codebase's frontmatter convention — apply-mode.ts:96 and pipeline.ts:1917 both
// stamp/compare `createHash(...).digest("hex").slice(0, 12)`, so the projection's `source.sha256`
// (project.ts renders it verbatim) must be the same 12-hex prefix for a re-stamp to verify. Kept
// here so graph.ts stays a leaf — it does NOT extend MdDoc or shell the binary (LOCKED DECISION 5).
export function computeSource(path: string, text: string): Source {
  const utf8 = Buffer.from(text, "utf8");
  return {
    path,
    bytes: utf8.length,
    sha256: createHash("sha256").update(utf8).digest("hex").slice(0, 12),
  };
}
