// locate-graph — the locate stage (spec §4 step 2; blueprint §2). It turns a `PreGraph`
// (parseExtractGraph's output: typed units carrying their verbatim `quote` but no `span`) into
// the span-anchored canonical `DistillationResult`, running `locate(body, quote)` per unit and
// edge. Per spec §4 this runs IMMEDIATELY after extract, not at end-of-pipeline — so a bad quote
// surfaces at the earliest possible point.
//
// This is the reparented core of the retired adapt.ts::comboToResult, MINUS the settled-artifact
// plumbing (no defByTerm / workflowSteps / orderedEntries / stepGroups carriers — the pre-graph
// already carries the final statements). Blueprint §7 step 8 wired distill()'s DEFAULT-compress
// path onto it (extract → locateGraph → projectMarkdown) and deleted adapt.ts; the three legacy
// output paths (routed / --glossary / --reference) still run the settle chain until steps 9-11.
//
// It is a leaf over the canonical modules: graph.ts (types + computeSource), locate.ts (the
// span-locate primitive), and REL_REGISTRY / slugSegment / Block from text.ts. It does NOT import
// pipeline.ts, so it carries no runtime dependency on the orchestrator.
//
// LOCKED: a failed `locate` HARD-ABORTS. `locate` throws a typed `LocateError` on a not-found or
// ambiguous quote; locateGraph lets it propagate unchanged (the projection is the DEFAULT compress
// body, so a bad quote must surface loudly — the spec §2 fidelity gate). There is NO coarse-span
// fallback.
import { computeSource, type Edge, type PreGraph, type Unit } from "./graph.ts";
import { locate } from "./locate.ts";
import { REL_REGISTRY, slugSegment, type Block } from "./text.ts";
import type { Projection } from "./project.ts";

// A payload subsection key: the first meaningful source line (fence markers skipped; blockquote /
// heading / list punctuation stripped; capped), else the ordinal `Payload N`. Used as the `### key`
// heading (project.ts renderPayload). Reparented from adapt.ts so locate-graph.ts stays a leaf that
// outlives adapt.ts.
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

// Resolve a relation endpoint (`to`) — a bare local headword-slug or a `[[file-slug]]` wikilink —
// to a LOCAL unit id via a slug→id map: strip the wikilink brackets and any `|alias` before
// slugging, then look the slug up. Returns undefined when nothing local matches (a cross-note
// wikilink or an unknown endpoint) so the caller drops the edge — projectMarkdown throws on a `to`
// that references no unit.
function resolveEndpoint(to: string, slugToId: Map<string, string>): string | undefined {
  const wl = /^\[\[(.+)\]\]$/.exec(to.trim());
  const target = wl ? wl[1].split("|")[0].trim() : to;
  const slug = slugSegment(target);
  return slug ? slugToId.get(slug) : undefined;
}

// Turn a pre-graph into the span-anchored canonical graph (spec §4 step 2; blueprint §2). Every
// unit/edge span is `locate(body, quote)`; a failed locate propagates (HARD-ABORT). `payloadBlocks`
// is the deterministic retain lane (blueprint §1.1) — payload is NOT a pre-graph channel, so it
// rides in here as an optional argument (the primary signature is `(pre, path, body)`; the pipeline
// passes the retain-graded blocks at step 8). `title`/`abstract` ride on the returned `Projection`
// (project.ts models them as optional on `Projection extends DistillationResult`, so the projector
// renders them without widening the canonical `DistillationResult`).
export function locateGraph(
  pre: PreGraph,
  path: string,
  body: string,
  payloadBlocks: Block[] = [],
): Projection {
  const source = computeSource(path, body);
  const units: Unit[] = [];

  // concept units ← pre.concepts: statement is the final def; span locates the verbatim quote.
  for (const c of pre.concepts) {
    units.push({
      id: c.id ?? "",
      type: "concept",
      statement: c.statement,
      span: locate(body, c.quote),
    });
  }

  // judgment units ← pre.judgements: id "J1".., modality carried from the pre-graph (assertoric
  // unless the model marked hypothesis/necessarily).
  pre.judgements.forEach((j, i) => {
    units.push({
      id: `J${i + 1}`,
      type: "judgment",
      statement: j.statement,
      span: locate(body, j.quote),
      modality: j.modality,
    });
  });

  // inference units ← pre.inferences: id "I1"..
  pre.inferences.forEach((inf, i) => {
    units.push({
      id: `I${i + 1}`,
      type: "inference",
      statement: inf.statement,
      span: locate(body, inf.quote),
    });
  });

  // procedure units ← pre.procedures: one unit per group. statement = the group's steps joined by
  // "\n"; span locates the lead step's quote (the representative slice — coarse; per-step spans are
  // deferred, blueprint §8 gap #1). id = the group's headword, fallback `Procedure N`.
  pre.procedures.forEach((p, i) => {
    if (p.steps.length === 0) return;
    const statement = p.steps
      .map((s) => s.statement)
      .filter((s) => s && s.trim().length > 0)
      .join("\n");
    units.push({
      id: p.headword.trim() || `Procedure ${i + 1}`,
      type: "procedure",
      statement,
      span: locate(body, p.steps[0].quote),
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

  // edges ← pre.edges. FILTER BEFORE PROJECTING: drop an off-registry rel and drop an endpoint that
  // resolves to no local unit (a cross-note wikilink) — projectMarkdown throws on both. Only a
  // retained edge's quote is located (so a dropped edge's absent/bad quote never aborts the run); a
  // retained edge's failed locate propagates (HARD-ABORT).
  const edges: Edge[] = [];
  for (const e of pre.edges) {
    if (!REL_REGISTRY.includes(e.rel)) continue; // off-registry rel → drop
    const to = resolveEndpoint(e.to, slugToId);
    if (to === undefined) continue; // no local unit endpoint → drop
    edges.push({ from: e.fromHeadword, to, rel: e.rel, span: locate(body, e.quote) });
  }

  return { source, units, edges, title: pre.title, abstract: pre.abstract };
}
