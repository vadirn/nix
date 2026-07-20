// locate-graph — the locate stage: the second of distill's pipeline stages (extract → locate →
// project). It turns a `PreGraph` (parseExtractGraph's output: typed units
// carrying their verbatim `quote` but no `span`) into the span-anchored canonical
// `DistillationResult`. This runs IMMEDIATELY after extract, not at end-of-pipeline — so a bad
// quote surfaces at the earliest possible point.
//
// This is the reparented core of the retired adapt.ts::comboToResult, MINUS the settled-artifact
// plumbing (no defByTerm / workflowSteps / orderedEntries / stepGroups carriers — the pre-graph
// already carries the final statements). distill()'s DEFAULT-compress path now runs extract →
// locateGraph → projectMarkdown, replacing the deleted adapt.ts; the three legacy output paths
// (routed / --glossary / --reference) still run the settle chain.
//
// It is a leaf over the canonical modules: graph.ts (types + computeSource), snap.ts (the
// block-granular anchor for idea-lane quotes), locate.ts (the byte-exact anchor for the payload
// lane), and slugSegment / Block from text.ts. It does NOT import distill-core.ts, so it carries no
// runtime dependency on the orchestrator.
//
// LOCKED: an idea-lane quote is an ABSTRACTIVE pointer (the model rewrote the source), so it SNAPS
// to the enclosing mdstruct block via snapQuote — a paraphrase/glyph-swap/stitch resolves to a
// block-granular span instead of hard-failing. A snap MISS still HARD-ABORTS: snapQuote throws
// `SnapError` on a non-empty score-0 quote, and snapRequired ALSO aborts on the empty-quote null (a
// head unit MUST anchor). The PAYLOAD lane alone stays on byte-exact `locate` (its statement IS the
// verbatim block), keeping `LocateError`'s tight hard gate. There is NO coarse-span fallback.
import { computeSource, type Edge, type PreGraph, type Unit } from "textkit/distill/graph/graph.ts";
import { locate } from "textkit/distill/extract/locate.ts";
import {
  buildSnapTargets,
  snapQuote,
  snapRequired,
  type SnapTarget,
} from "textkit/distill/extract/snap.ts";
import { oneLine } from "textkit/distill/extract/harvest.ts";
import { parseDoc, type Span } from "textkit/distill/mdstruct.ts";
import { slugSegment, type Block } from "textkit/core/text.ts";
import type { Projection } from "textkit/distill/graph/project.ts";

// Snap a sub-element's (bullet / tail-step) quote to its enclosing-block span, or `null` when the
// model gave no quote (an empty quote is a deliberate no-anchor, not a hallucination — it renders
// unanchored, the synthesized-step convention). snapQuote itself returns null on an empty-normalized
// quote, so no explicit empty guard is needed. A PRESENT quote still hard-aborts on a snap miss
// (snapQuote throws SnapError), so the anti-hallucination gate holds for every anchored sub-element,
// not just the head.
function snapSub(quote: string, targets: SnapTarget[]): Span | null {
  return snapQuote(quote, targets)?.span ?? null;
}

// A payload subsection key: the first meaningful source line (fence markers skipped; blockquote /
// heading / list punctuation stripped; capped), else the ordinal `Payload N`. Used as the `### key`
// heading (project.ts renderPayload). Reparented from adapt.ts so locate-graph.ts stays a leaf that
// outlives adapt.ts.
export function payloadKey(text: string, n: number): string {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (/^(`{3,}|~{3,})/.test(line)) continue; // a bare fence marker is not a key
    const cleaned = line
      .replace(/^[>#\-*+\s]+/, "") // blockquote / heading / list-marker prefix
      .replace(/`/g, "")
      .trim();
    if (cleaned) return oneLine(cleaned, 60);
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

// Turn a pre-graph into the span-anchored canonical graph. Idea-lane unit/edge spans SNAP to their
// enclosing block via `snapQuote` against `targets`; the payload lane alone uses byte-exact
// `locate`. A snap/locate miss propagates (HARD-ABORT). `payloadBlocks` is the deterministic retain
// lane — payload is NOT a pre-graph channel, so it rides in here as an optional argument. `targets`
// is the snap-target list, built ONCE from `parseDoc(body)` and threaded to every idea-lane anchor.
// `title`/`abstract` ride on the returned `Projection` (project.ts models them as optional on
// `Projection extends DistillationResult`, so the projector renders them without widening the
// canonical `DistillationResult`).
export function locateGraph(
  pre: PreGraph,
  path: string,
  body: string,
  payloadBlocks: Block[] = [],
): Projection {
  const source = computeSource(path, body);
  const targets = buildSnapTargets(parseDoc(body));
  const units: Unit[] = [];

  // concept units ← pre.concepts: statement is the final def joined with any extension bullets;
  // `span` SNAPS the def's quote to its enclosing block, `subSpans` snaps each bullet's own quote
  // (per-sub-element anchoring). A bullet with no quote yields a null hole. NB: every idea-lane
  // `span` here is BLOCK-GRANULAR — the enclosing mdstruct block, not the quote's exact byte
  // extent — since the quote is an abstractive (paraphrased) pointer, not a verbatim slice (F3).
  for (const c of pre.concepts) {
    const bullets = (c.bullets ?? []).filter((b) => b.statement.trim().length > 0);
    const statement = [c.statement, ...bullets.map((b) => b.statement)]
      .filter((s) => s && s.trim().length > 0)
      .join("\n");
    const subSpans = bullets.map((b) => snapSub(b.quote, targets));
    units.push({
      id: c.id ?? "",
      type: "concept",
      statement,
      span: snapRequired(c.quote, targets),
      ...(subSpans.length ? { subSpans } : {}),
    });
  }

  // judgment units ← pre.judgements: id "J1".., modality carried from the pre-graph (assertoric
  // unless the model marked hypothesis/necessarily).
  pre.judgements.forEach((j, i) => {
    units.push({
      id: `J${i + 1}`,
      type: "judgment",
      statement: j.statement,
      span: snapRequired(j.quote, targets),
      modality: j.modality,
    });
  });

  // inference units ← pre.inferences: id "I1"..
  pre.inferences.forEach((inf, i) => {
    units.push({
      id: `I${i + 1}`,
      type: "inference",
      statement: inf.statement,
      span: snapRequired(inf.quote, targets),
    });
  });

  // procedure units ← pre.procedures: one unit per group. statement = the group's steps joined by
  // "\n"; `span` locates the LEAD step's quote and `subSpans` locates each remaining step's own
  // quote (per-step anchoring) — a step with no quote yields a null hole (rendered unanchored,
  // the synthesized-step-2 convention). id = the group's headword, fallback `Procedure N`.
  pre.procedures.forEach((p, i) => {
    const steps = p.steps.filter((s) => s.statement && s.statement.trim().length > 0);
    if (steps.length === 0) return;
    const statement = steps.map((s) => s.statement).join("\n");
    const [lead, ...rest] = steps;
    const subSpans = rest.map((s) => snapSub(s.quote, targets));
    units.push({
      id: p.headword.trim() || `Procedure ${i + 1}`,
      type: "procedure",
      statement,
      span: snapRequired(lead.quote, targets),
      ...(subSpans.length ? { subSpans } : {}),
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

  // edges ← pre.edges. FILTER BEFORE PROJECTING: drop an endpoint that resolves to no local unit
  // (a cross-note wikilink). `rel` is an OPEN token — REL_REGISTRY (text.ts) is a known
  // vocabulary, not a closed enum, so an off-registry rel (e.g. a deontic or causal predicate) is
  // KEPT, not dropped (Chesterton's Fence: a closed enum could not hold a deontic relation). Only
  // a retained edge's quote is snapped (so a dropped edge's absent/bad quote never aborts the
  // run); a retained edge is a head unit, so a snap miss propagates (HARD-ABORT).
  const edges: Edge[] = [];
  for (const e of pre.edges) {
    const to = resolveEndpoint(e.to, slugToId);
    if (to === undefined) continue; // no local unit endpoint → drop
    edges.push({ from: e.fromHeadword, to, rel: e.rel, span: snapRequired(e.quote, targets) });
  }

  return { source, units, edges, title: pre.title, abstract: pre.abstract };
}
