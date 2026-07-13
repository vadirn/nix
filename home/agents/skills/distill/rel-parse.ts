// rel-parse — the `## Relations` REBUILD parser (W1): read an emitted note's `## Relations`
// block back into structural edges. The inverse of the projection's `## Relations` emit,
// so cards/ reads a distilled note's structural channels through one seam (D13). Lives a
// tier above text.ts (leaf slug/fence helpers) and graph.ts (the shared emit grammar consts);
// text.ts re-exports `parseRelationsBlock` only as a compat shim for cards/. Lossy-tolerant
// throughout (D29): a malformed line yields no edge and parsing never throws.
import { REL_ARROW, REL_DASH, TRAILING_ANCHOR_RE } from "./graph.ts";
import { fenceScan, type FenceState, slugSegment, stripFences } from "./text.ts";

// One structural edge parsed off a `## Relations` list item. `from` is the entry's
// own slug (multi-node form) or null (single-atom form omits the from-label, D26).
// `to` keeps the endpoint's EMITTED form verbatim — `[[file-slug]]` stays bracketed,
// a bare term-slug stays bare — so a caller can re-slug or re-attach it without ambiguity.
export type ParsedRelationEdge = {
  from: string | null;
  rel: string;
  to: string;
  predicate: string | null;
};

// ATX heading grammar (marker + title, trailing `#` markers stripped). extractSection (the
// `## Relations`/`## Glossary` REBUILD toggle) scans for ATX headings on a fence-masked copy.
const ATX_HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

// Toggle-based section extraction: an H2 heading whose slugged text equals `name`
// opens the section; ANY other heading (any depth) closes it; `collecting` is
// recomputed on every heading rather than latched, so a same-named H2 appearing
// again later reopens the section. Heading detection runs on a fence-masked copy so
// a fenced `# comment` cannot toggle the section (the sections() fix, d06c6fa) while
// the returned text keeps the RAW lines (fences intact) for the caller to re-scan.
//
// DIVERGENCE from vault-query's canonical rule (relations.rs::parse_relations /
// markdown::heading_text), which opens on ANY depth 1-6: this is the REBUILD inverse
// of the legacy two-channel emit grammar, whose channels are exactly `## Glossary` /
// `## Relations` — and the routed build DEMOTES a preserved section's colliding
// `## Glossary` to `### Glossary` (assembleRoutedNote's demote sweep) precisely to
// mark it as source material, not channel. Any-depth opening reads those demoted
// source tables back as channel rows (live-run finding: a preserve section's 20-row
// property table enumerated as 20 card candidates), so depth is load-bearing here.
function extractSection(md: string, name: string): string {
  const lines = md.split("\n");
  const masked = stripFences(md).split("\n");
  let collecting = false;
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const h = ATX_HEADING.exec(masked[i]);
    if (h) {
      collecting = h[1] === "##" && slugSegment(h[2]) === name;
      continue;
    }
    if (collecting) out.push(lines[i]);
  }
  return out.join("\n");
}

// Split a `<endpoint> (<predicate>)` tail into its two parts.
//
// DIVERGENCE from vault-query/src/commands/lint/relations.rs::split_predicate: the Rust
// scanner takes the LAST `(` in the string (`rfind`), which mis-splits whenever the
// predicate itself carries a parenthetical — the predicate's own inner `(` wins over the
// wrap's outer one, truncating the endpoint and corrupting the predicate (verified: Rust's
// algorithm, mirrored naively, turns `endpoint (a (b))` into endpoint `"endpoint (a"` /
// predicate `"b)"`). This mirror instead finds the `(` whose matching `)` is the string's
// own LAST character (depth-balanced scan from the end), so a predicate containing "(...)"
// round-trips correctly. The two algorithms agree on every case without nested parens
// (the golden fixture, every emitted note today), so this is invisible parity for existing
// output and only helps a future nested-predicate emission. Rust's lint side is unaffected
// (out of scope here) — flagged for a follow-up there.
function splitPredicate(right: string): { endpoint: string; predicate: string | null } {
  if (!right.endsWith(")")) return { endpoint: right, predicate: null };
  let depth = 0;
  let open = -1;
  for (let i = right.length - 1; i >= 0; i--) {
    const c = right[i];
    if (c === ")") depth++;
    else if (c === "(") {
      depth--;
      if (depth === 0) {
        open = i;
        break;
      }
    }
  }
  if (open < 0) return { endpoint: right, predicate: null };
  const predicate = right.slice(open + 1, -1).trim();
  const endpoint = right.slice(0, open).trim();
  return { endpoint, predicate: predicate || null };
}

// Parse the projector's emit grammar `<from> — <rel> → <to>[  <anchor>]`
// (project.ts::renderRelation: em-dash U+2014, right-arrow U+2192, both space-flanked,
// a trailing `  start..end`/`[start..end]` anchor). This is the TRUE inverse of the
// `## Relations` projection — the form a distilled note carries on disk, which
// card-stage reads back (D13). Lossy (D29): returns null on anything short of
// well-formed rather than throwing.
function parseArrowEdge(edgeText: string): ParsedRelationEdge | null {
  const body = edgeText.replace(TRAILING_ANCHOR_RE, "").trim();
  const arrow = body.indexOf(REL_ARROW);
  if (arrow < 0) return null;
  const left = body.slice(0, arrow).trim();
  const to = body.slice(arrow + REL_ARROW.length).trim();
  if (!to) return null;
  const dash = left.indexOf(REL_DASH);
  if (dash < 0) return null;
  const from = left.slice(0, dash).trim();
  const rel = left.slice(dash + REL_DASH.length).trim();
  if (!from || !rel) return null;
  const { endpoint, predicate } = splitPredicate(to);
  if (!endpoint) return null;
  return { from, rel, to: endpoint, predicate };
}

// Parse one `## Relations` list-item body (the text after the `- `/`* ` marker) into a
// structural edge, accepting BOTH grammars a note may carry: the projector's emitted
// `<from> — <rel> → <to>  <anchor>` form (parseArrowEdge, the projection inverse) and
// the legacy/vault two-channel `[<from> ]<rel>:: <to>[ (<predicate>)]` form (mirrors
// vault-query relations.rs). The arrow form is tried first — it is what distilled notes
// on disk actually contain. Lossy (D29): returns null on anything short of well-formed
// rather than throwing — a line matching neither grammar, an empty rel/endpoint, or an
// all-parenthetical tail with no endpoint before it.
function parseEdgeLine(edgeText: string): ParsedRelationEdge | null {
  const arrow = parseArrowEdge(edgeText);
  if (arrow) return arrow;
  const sep = edgeText.indexOf("::");
  if (sep < 0) return null;
  const left = edgeText.slice(0, sep).trim();
  const right = edgeText.slice(sep + 2).trim();
  if (!left || !right) return null;
  const tokens = left.split(/\s+/).filter(Boolean);
  const rel = tokens.pop();
  if (!rel) return null;
  const from = tokens.length ? tokens.join(" ") : null;
  const { endpoint, predicate } = splitPredicate(right);
  if (!endpoint) return null;
  return { from, rel, to: endpoint, predicate };
}

// Parse a full note body's `## Relations` section back into structural edges — the
// REBUILD inverse of the projection's `## Relations` emit. Section framing (fence
// tracking, heading toggle, `- `/`* ` list-item prefix) mirrors
// vault-query/src/commands/lint/relations.rs::parse_relations line-for-line; the
// per-line grammar (parseEdgeLine) reads BOTH the projector's `— … →` emit form and the
// legacy `::` form, so a distilled note on disk and a vault note both parse. See
// splitPredicate for the one intentional divergence. Lossy-tolerant like
// normalizeRelation: a malformed line yields no edge and parsing never throws.
export function parseRelationsBlock(md: string): ParsedRelationEdge[] {
  const edges: ParsedRelationEdge[] = [];
  let fence: FenceState = null;
  for (const raw of extractSection(md, "relations").split("\n")) {
    const scan = fenceScan(raw, fence);
    fence = scan.fence;
    if (scan.isMarker) continue;
    if (fence) continue;
    const item = /^[-*] (.*)$/.exec(raw.trimStart());
    if (!item) continue;
    const edge = parseEdgeLine(item[1]);
    if (edge) edges.push(edge);
  }
  return edges;
}
