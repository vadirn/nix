// graph.ts — the canonical distillation graph, distill's source of truth. A `DistillationResult`
// is a typed, span-anchored knowledge graph `{ source, units[], edges[] }` over the five
// knowledge-element types; markdown is one projection of it (spec §1). This is a LEAF module:
// it imports only the `Span` byte-offset type from mdstruct.ts so the type contract stays free
// of the CLI-wrapper's runtime dependencies. The shipped two-channel `Combo`/`GlossEntry`/
// `Relation` shape in text.ts is untouched and coexists during migration (LOCKED DECISION 4).
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

// Compute a `Source` in TS matching mdstruct's build.rs (build.rs:196): `bytes` is the UTF-8
// byte length of `text` and `sha256` is the hex sha256 of those same UTF-8 bytes. Kept here so
// graph.ts stays a leaf — it does NOT extend MdDoc or shell the binary (LOCKED DECISION 5).
export function computeSource(path: string, text: string): Source {
  const utf8 = Buffer.from(text, "utf8");
  return {
    path,
    bytes: Buffer.byteLength(text, "utf8"),
    sha256: createHash("sha256").update(utf8).digest("hex"),
  };
}
