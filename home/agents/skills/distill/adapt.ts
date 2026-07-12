// adapt — the end-of-pipeline adapter that reconstructs a canonical `DistillationResult`
// (graph.ts) from distill()'s SETTLED artifacts, so the markdown projection (project.ts) can
// be emitted in place of the legacy `assembleBody`. This runs AT THE END, not at extract time:
// the stages between extract and assemble author and gate the very definitions and steps the
// projection needs (defByTerm, workflowSteps), so the graph is built from what settled, never
// from the raw extract (wiring plan §"STEP 8").
//
// It is a leaf over the canonical modules: graph.ts (types + computeSource), locate.ts (the
// span-locate fidelity primitive), and REL_REGISTRY / slugSegment / the two-channel types from
// text.ts. It does NOT import pipeline.ts — the caller pre-computes the workflow step groups
// (computeStepGroups) and passes them in, so adapt.ts carries no runtime dependency on the
// orchestrator (and no import cycle).
//
// LOCKED: a failed `locate` HARD-ABORTS. `locate` throws a typed `LocateError` on a not-found or
// ambiguous quote; the adapter lets it propagate out of `comboToResult` unchanged (the flip is
// opt-in behind `--canonical`, so a bad quote must surface loudly — it is the spec §2 fidelity
// gate). There is NO whole-block coarse-span fallback.
import {
  computeSource,
  type DistillationResult,
  type Edge,
  type Modality,
  type Unit,
} from "./graph.ts";
import { locate } from "./locate.ts";
import {
  REL_REGISTRY,
  slugSegment,
  type Block,
  type Combo,
  type GlossEntry,
  type Relation,
  type WorkStep,
} from "./text.ts";
import type { Projection } from "./project.ts";

// One workflow step group, as computeStepGroups (pipeline.ts) produces it — steps sharing a
// source block-set. Only `idxs` (positions into orderedSteps / workflowSteps) is read here; the
// group's `id`/`sourceText` are pipeline-internal. Declared structurally so the caller can pass
// `computeStepGroups(...)` straight through without adapt.ts importing pipeline.ts.
export interface StepGroupLike {
  idxs: number[];
}

// The settled artifacts distill() holds just before the final assemble call (pipeline.ts:1013).
// `body` is the exact frontmatter-stripped string distill() ran locate against, so every span is
// a self-consistent byte offset INTO body (not into the whole file).
export interface ComboToResultArgs {
  path: string;
  body: string;
  combo: Combo;
  orderedEntries: GlossEntry[];
  orderedSteps: WorkStep[];
  // The gate-settled workflow step strings, parallel to orderedSteps (same indices).
  workflowSteps: string[];
  // The gate-settled definitions, keyed by term (overrides an entry's raw `def`).
  defByTerm: Map<string, string>;
  // Retain-graded blocks — the payload units (statement IS the verbatim slice).
  payloadBlocks: Block[];
  // orderedSteps grouped by shared source block-set (computeStepGroups output). One procedure
  // unit per group.
  stepGroups: StepGroupLike[];
}

// A procedure subsection heading is a bare ordinal (`Procedure 1`, `Procedure 2`, …) over the
// groups in computeStepGroups order — deterministic and collision-free. A descriptive heading
// from the lead directive, and per-step spans, need step-level units (wiring plan Backlog 2).
function procedureId(n: number): string {
  return `Procedure ${n}`;
}

// A payload subsection key: the first meaningful source line (fence markers skipped;
// blockquote / heading / list punctuation stripped; capped), else the ordinal `Payload N`. Used
// as the `### key` heading (project.ts renderPayload) — the plan's "first line or Payload+n".
function payloadKey(text: string, n: number): string {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (/^(`{3,}|~{3,})/.test(line)) continue; // a bare fence marker is not a key
    const cleaned = line
      .replace(/^[>#\-*+\s]+/, "") // blockquote / heading / list-marker prefix
      .replace(/`/g, "")
      .trim();
    if (cleaned) return cleaned.length > 60 ? cleaned.slice(0, 59) + "…" : cleaned;
  }
  return `Payload ${n}`;
}

// Resolve a relation endpoint (`r.to`) — a bare local term-slug or a `[[file-slug]]` wikilink —
// to a LOCAL unit id via a slug→id map, mirroring the assembler's endpointOf (assemble.ts): strip
// the wikilink brackets and any `|alias` before slugging, then look the slug up. Returns undefined
// when nothing local matches (a cross-note wikilink or an unknown endpoint) so the caller drops
// the edge — projectMarkdown throws on a `to` that references no unit.
function resolveEndpoint(to: string, slugToId: Map<string, string>): string | undefined {
  const wl = /^\[\[(.+)\]\]$/.exec(to.trim());
  const target = wl ? wl[1].split("|")[0].trim() : to;
  const slug = slugSegment(target);
  return slug ? slugToId.get(slug) : undefined;
}

// Map an extract modality (`"hypothesis" | "necessarily" | null`) onto graph.ts `Modality`: the
// unmarked `null` becomes `"assertoric"` (spec §3 — an unmarked judgment is assertoric).
function toModality(m: "hypothesis" | "necessarily" | null): Modality {
  return m ?? "assertoric";
}

// Reconstruct the canonical distillation graph from distill()'s settled artifacts (wiring plan
// §"STEP 8"). Every unit/edge span is `locate(body, quote)`; a failed locate propagates
// (HARD-ABORT). `title`/`abstract` ride on the returned Projection (project.ts models them as
// optional on `Projection extends DistillationResult`, so the projector renders them without
// widening the canonical `DistillationResult`).
export function comboToResult(args: ComboToResultArgs): Projection {
  const {
    path,
    body,
    combo,
    orderedEntries,
    orderedSteps,
    workflowSteps,
    defByTerm,
    payloadBlocks,
    stepGroups,
  } = args;

  const source = computeSource(path, body);
  const units: Unit[] = [];

  // concept units ← orderedEntries: statement is the gate-settled def; span locates the entry's
  // verbatim quote.
  for (const e of orderedEntries) {
    units.push({
      id: e.term,
      type: "concept",
      statement: defByTerm.get(e.term) ?? e.def,
      span: locate(body, e.quote ?? ""),
    });
  }

  // judgment units ← combo.judgements: id "J1".., extract null modality → assertoric.
  (combo.judgements ?? []).forEach((j, i) => {
    units.push({
      id: `J${i + 1}`,
      type: "judgment",
      statement: j.statement,
      span: locate(body, j.quote ?? ""),
      modality: toModality(j.modality),
    });
  });

  // inference units ← combo.inferences: id "I1"..
  (combo.inferences ?? []).forEach((inf, i) => {
    units.push({
      id: `I${i + 1}`,
      type: "inference",
      statement: inf.statement,
      span: locate(body, inf.quote ?? ""),
    });
  });

  // procedure units ← orderedSteps grouped by computeStepGroups: one unit per group. The
  // statement is the group's settled workflowSteps joined by "\n"; the span locates the group's
  // lead-step quote (the representative slice — coarse; per-step spans are Backlog).
  stepGroups.forEach((g, i) => {
    if (g.idxs.length === 0) return;
    const statement = g.idxs
      .map((idx) => workflowSteps[idx])
      .filter((s) => s && s.trim().length > 0)
      .join("\n");
    const lead = orderedSteps[g.idxs[0]];
    units.push({
      id: procedureId(i + 1),
      type: "procedure",
      statement,
      span: locate(body, lead?.quote ?? ""),
    });
  });

  // payload units ← payloadBlocks (retain-graded): statement IS the verbatim block text; span
  // locates that same text in body.
  payloadBlocks.forEach((b, i) => {
    units.push({
      id: payloadKey(b.text, i + 1),
      type: "payload",
      statement: b.text,
      span: locate(body, b.text),
    });
  });

  // slug→id over ALL units (concepts first, first-wins) so an edge endpoint resolves to the exact
  // unit id projectMarkdown keys on.
  const slugToId = new Map<string, string>();
  for (const u of units) {
    const s = slugSegment(u.id);
    if (s && !slugToId.has(s)) slugToId.set(s, u.id);
  }

  // edges ← each concept entry's relations. FILTER BEFORE PROJECTING: drop an off-registry rel and
  // drop an endpoint that resolves to no local unit (a cross-note wikilink) — projectMarkdown
  // throws on both. Only a retained edge's quote is located (so a dropped edge's absent/bad quote
  // never aborts the run); a retained edge's failed locate propagates (HARD-ABORT).
  const edges: Edge[] = [];
  for (const e of orderedEntries) {
    for (const r of e.relations as Relation[]) {
      if (!REL_REGISTRY.includes(r.rel)) continue; // off-registry rel → drop
      const to = resolveEndpoint(r.to, slugToId);
      if (to === undefined) continue; // no local unit endpoint → drop
      edges.push({ from: e.term, to, rel: r.rel, span: locate(body, r.quote ?? "") });
    }
  }

  return {
    source,
    units,
    edges,
    title: combo.title,
    abstract: combo.abstract,
  };
}
