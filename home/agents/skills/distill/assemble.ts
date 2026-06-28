// assemble — turn the settled IR (prose head, workflow steps, glossary entries,
// retained blocks) into the final markdown body, and emit the `## Relations`
// block. Pure formatting; no I/O, no model calls.
import { slugSegment, type Block, type GlossEntry } from "./text.ts";

// ---- assembly: head prose + glossary table + retained-verbatim blocks ----
// `head` is the prose that sits above the table: the full connective note in the
// default mode (relations live here), or the short tie-together in --core-only.
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
export function emitRelationsBlock(orderedEntries: GlossEntry[]): string {
  const singleAtom = orderedEntries.length === 1;
  const lines: string[] = [];
  for (const entry of orderedEntries) {
    for (const r of entry.relations) {
      const wl = /^\[\[(.+)\]\]$/.exec(r.to.trim());
      const endpoint = wl ? `[[${slugSegment(wl[1])}]]` : slugSegment(r.to);
      if (!endpoint) continue; // an endpoint that slugs to empty is unrenderable
      const pred = r.predicate ? ` (${r.predicate})` : "";
      lines.push(
        singleAtom
          ? `- ${r.rel}:: ${endpoint}${pred}`
          : `- ${slugSegment(entry.term)} ${r.rel}:: ${endpoint}${pred}`,
      );
    }
  }
  return lines.length ? `## Relations\n\n${lines.join("\n")}` : "";
}

export function assembleBody(
  h1: string,
  head: string,
  workflowSteps: string[],
  orderedEntries: GlossEntry[],
  defByTerm: Map<string, string>,
  retained: Block[],
  isReference: boolean,
): string {
  const parts: string[] = [];
  if (h1) parts.push(h1);
  if (head) parts.push(head);
  if (workflowSteps.length) {
    // filter empties before numbering: the verbatim fallback blanks surplus slots
    // when a group's source yields fewer directive clauses than it had draft steps,
    // so renumber over what remains rather than emitting a gap.
    const items = workflowSteps
      .map((s) => s.replace(/\n+/g, " ").trim())
      .filter(Boolean)
      .map((s, i) => `${i + 1}. ${s}`)
      .join("\n");
    if (items) parts.push(`## Workflow\n\n${items}`);
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
  if (retained.length) parts.push(retained.map((b) => b.text).join("\n\n"));
  return parts.join("\n\n");
}
