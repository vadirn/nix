// assemble — turn the settled combo (prose head, workflow steps, glossary entries,
// retained blocks) into the final markdown body, and emit the `## Relations`
// block. Pure formatting; no I/O, no model calls.
import { isContentfulStep, slugSegment, type Block, type GlossEntry } from "./text.ts";

// ---- assembly: head prose + glossary table + retained-verbatim blocks ----
// `head` is the prose that sits above the table: the full connective note in the
// default mode (relations live here), or the short tie-together in --glossary.
// The `## Glossary` table carries definitions only — relations are not a column;
// they are carried by the connective prose (see connectiveProse).
function escCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}

export const escAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

// Build the `## Relations` block body (D29 structural channel). One markdown list
// item per edge, in entry order then each entry's relation order. A single-atom card
// (orderedEntries.length === 1) OMITS the from-label, emitting `- <rel>:: <endpoint>`;
// a multi-node note PREFIXES each edge with the source entry's own slug as the
// from-label. Endpoint scope is marked by brackets: a `[[file-slug]]` stays a
// wikilink (inner re-slugged), a bare label becomes a local term-slug. Labels are
// pre-slugified so the block is byte-stable. Exported for isolated unit testing.
// Returns "" when no entry carries an edge.
function endpointOf(to: string): string {
  const wl = /^\[\[(.+)\]\]$/.exec(to.trim());
  if (!wl) return slugSegment(to);
  // Strip the alias BEFORE slugging (harvestWikilinks does the same split, text.ts:170)
  // — `[[note-aliased|Display Text]]` must endpoint on `note-aliased`, not on a slug of
  // the whole "target|alias" string, or the emitted wikilink targets a note that was
  // never the edge's actual endpoint (Finding 2).
  const target = wl[1].split("|")[0].trim();
  return `[[${slugSegment(target)}]]`;
}

export function emitRelationsBlock(orderedEntries: GlossEntry[]): string {
  const singleAtom = orderedEntries.length === 1;
  const lines: string[] = [];
  for (const entry of orderedEntries) {
    const fromSlug = slugSegment(entry.term);
    for (const r of entry.relations) {
      const endpoint = endpointOf(r.to);
      if (!endpoint) continue; // an endpoint that slugs to empty is unrenderable
      if (endpoint === fromSlug) continue; // self-loop (from==to) is vacuous extraction junk
      const pred = r.predicate ? ` (${r.predicate})` : "";
      lines.push(
        singleAtom
          ? `- ${r.rel}:: ${endpoint}${pred}`
          : `- ${fromSlug} ${r.rel}:: ${endpoint}${pred}`,
      );
    }
  }
  return lines.length ? `## Relations\n\n${lines.join("\n")}` : "";
}

// Render a "## Workflow" block from a flat step list, numbering from `startAt` so a
// fragment spliced in after an earlier one can continue the sequence (a routed note's
// workflow is one procedure split across the note by section position, not several
// independent lists — see reassembleNote/assembleRoutedNote in pipeline.ts). Filter empties
// before numbering: the verbatim fallback blanks surplus slots when a group's source yields
// fewer directive clauses than it had draft steps, so renumber over what remains rather than
// emitting a gap.
export function renderWorkflowBlock(steps: string[], startAt = 1): { text: string; count: number } {
  const items = steps.map((s) => s.replace(/\n+/g, " ").trim()).filter(isContentfulStep);
  return {
    text: items.length
      ? `## Workflow\n\n${items.map((s, i) => `${startAt + i}. ${s}`).join("\n")}`
      : "",
    count: items.length,
  };
}

export function assembleBody(
  h1: string,
  head: string,
  workflowSteps: string[],
  orderedEntries: GlossEntry[],
  defByTerm: Map<string, string>,
  payloadBlocks: Block[],
  isReference: boolean,
): string {
  const parts: string[] = [];
  if (h1) parts.push(h1);
  if (head) parts.push(head);
  if (workflowSteps.length) {
    const { text } = renderWorkflowBlock(workflowSteps);
    if (text) parts.push(text);
  }
  if (orderedEntries.length) {
    const rows = orderedEntries
      .map((e) => `| ${escCell(e.term)} | ${escCell(defByTerm.get(e.term) ?? e.def)} |`)
      .join("\n");
    parts.push(`## Glossary\n\n| Term | Definition |\n| ---- | ---------- |\n${rows}`);
  }
  // D30: a type:reference body stays link-free — never emit a `## Relations` block
  // into one. distill emits no references today, so this guard is currently a no-op
  // kept for a future reference-distill path. Section order = push order.
  if (!isReference) {
    const rel = emitRelationsBlock(orderedEntries);
    if (rel) parts.push(rel);
  }
  if (payloadBlocks.length) parts.push(payloadBlocks.map((b) => b.text).join("\n\n"));
  return parts.join("\n\n");
}
