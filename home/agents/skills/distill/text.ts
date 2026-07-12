// text — segmentation, typography, slugging, relation/Combo types, and the language
// helpers. The leaf module of the distill pipeline: pure string/data utilities
// with no I/O; its only dependency is writing/typography.ts, the writing-core's
// own leaf (normalizeTypography moved there, re-exported here).
import { normalizeTypography } from "./writing/typography.ts";
import {
  parseDoc,
  sliceBytes,
  walkNodes,
  walkHeadings,
  type ParsedDoc,
  type Span,
  type MdNode,
  type MdInline,
  type Heading,
} from "./mdstruct.ts";

// Relations registry — TS-native copy of the open relation vocabulary (structural
// channel only, D32). Mirror of vault-query/src/commands/lint/rel-registry.json, the
// test-only canonical ground truth; parity is pinned by distill.test.ts (which reads
// that JSON and asserts equality with this const). Read at runtime from here, never
// from the JSON, so emit stays file-I/O-free. Three tokens the extractor already emits
// (subsumes / precondition-for / contrast-to) plus four it is starting to emit
// (depends-on / part-of / instance-of / refines). supersedes and contradicts are
// excluded by channel (frontmatter- and merge-gated respectively).
export const REL_REGISTRY: readonly string[] = [
  "subsumes",
  "precondition-for",
  "contrast-to",
  "depends-on",
  "part-of",
  "instance-of",
  "refines",
];

export type Block = { id: string; text: string };
export type Grade = "drop" | "distill" | "retain";
// A relation is one STRUCTURAL edge (D29): `rel` an open hyphenated token, `to` an
// endpoint (a bare local term-slug or a [[file-slug]] wikilink), `predicate` an
// optional one-clause gloss (null when none). The from-label is NOT a field — it is
// the entry's own `term`, supplied by the assembler (emitRelationsBlock). `quote` is
// the VERBATIM source slice the edge was distilled from (byte-exact, never typography-
// normalized) — the span-locate anchor the canonical projection resolves; optional so
// the shipped two-channel path and REBUILD parsing keep working without it.
export type Relation = { rel: string; to: string; predicate: string | null; quote?: string };
// `quote` is the verbatim source slice this concept was distilled from (span-locate
// anchor, byte-exact); optional and inert to the shipped grade/order/synth/gate path.
export type GlossEntry = {
  term: string;
  def: string;
  relations: Relation[];
  source: string[];
  quote?: string;
};
// a workflow step is an ACTIONABLE directive the note prescribes (a practice, a
// procedure step) — the procedural sink the glossary (concepts) cannot hold. The
// step carries a source-stated reason ("do X because Y") when the source gives
// one; the gate tolerates a dropped reason but forbids an invented one. `quote` is
// the verbatim source slice the step was distilled from (span-locate anchor), optional.
export type WorkStep = { step: string; source: string[]; quote?: string };
// A JUDGEMENT is a stated claim the note asserts as true (an S-is-P assertion, an
// evaluation, a stance) — distinct from the concepts it is about. `modality` tags the
// note's own framing: "hypothesis" (problematic/tentative), "necessarily" (apodictic),
// or null (assertoric, the unmarked default). `quote` is the verbatim source slice,
// `source` the block IDs. The judgment channel of the typed extract (spec §1), read by
// the canonical adapter, inert to the shipped stages.
export type Judgement = {
  statement: string;
  modality: "hypothesis" | "necessarily" | null;
  source: string[];
  quote?: string;
};
// An INFERENCE is a claim the note DERIVES from others ("therefore", "so", "it follows
// that") — the derivation channel of the typed extract (spec §1). `quote` is the
// verbatim source slice, `source` the block IDs.
export type Inference = { statement: string; source: string[]; quote?: string };
// `title`/`abstract` are the document-level orientation of the typed extract (spec §3:
// the H1 and the one unanchored ## Abstract block); `judgements`/`inferences` are the
// judgment and inference channels. All four are OPTIONAL and additive — the shipped
// stages (grade/order/synthesize/revise/gate) destructure only
// {glossary, workflow, thesis, description}, so they are inert to those and read only
// by the canonical adapter.
export type Combo = {
  description: string;
  thesis: string;
  glossary: GlossEntry[];
  workflow: WorkStep[];
  title?: string;
  abstract?: string;
  judgements?: Judgement[];
  inferences?: Inference[];
};
// A vault edge: a [[wikilink]] OR a scheme-less [text](path) markdown link, both
// intra-vault cross-note relations. `markup` is the verbatim span, `slug` its target
// slugged for byte-stable comparison, `target` the raw alias/path-cleaned endpoint
// carried alongside `slug` as the collision discriminator in wikilinkResidue. The shared
// return shape of all three harvesters, so harvestVaultEdges concats them without an adapter.
export type VaultEdge = { markup: string; slug: string; target: string };

// The deterministic link inventory fed to the extractor as a MUST-COVER checklist:
// every [[wikilink]] (intra-vault edges) UNION every external [text](url) (citation /
// source links, a distinct lane that grounds to a reference node, NOT a vault relation).
export type LinkInventory = {
  wikilinks: VaultEdge[];
  external: { markup: string; text: string; url: string }[];
};

// ---- segmentation: fence-aware, split on blank lines; code fences stay whole ----
export function segment(text: string): Block[] {
  const lines = text.split("\n");
  const out: string[][] = [];
  let cur: string[] = [];
  let inFence = false;
  const flush = () => {
    if (cur.length) {
      out.push(cur);
      cur = [];
    }
  };
  for (const line of lines) {
    const t = line.trimStart();
    if (t.startsWith("```") || t.startsWith("~~~")) {
      inFence = !inFence;
      cur.push(line);
      continue;
    }
    if (inFence) {
      cur.push(line);
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    cur.push(line);
  }
  flush();
  return out.map((ls, i) => ({ id: `B${i + 1}`, text: ls.join("\n") }));
}

export function render(blocks: Block[]): string {
  return blocks.map((b) => `[${b.id}] ${b.text}`).join("\n\n");
}

export function wordCount(s: string): number {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
}

export const glossList = (entries: { term: string; def: string }[]): string =>
  entries.map((e) => `- ${e.term}: ${e.def}`).join("\n");

// a block carries a deliberate connection if it contains [[...]] — this also
// matches ![[...]] embeds, since the embed wraps a wikilink. Detection is
// deterministic so the protection cannot miss one.
const WIKILINK = /\[\[[^\]]+\]\]/;
export const hasWikilink = (text: string): boolean => WIKILINK.test(text);

// A workflow step carries no content when, stripped to its bare token, nothing but a list
// marker / ordinal / punctuation remains (e.g. "3." — the synth model echoing a list number
// instead of tightening the step). Such a token must never render as a step ("3. 3."): synth
// rejects it (keeping the extracted draft) and assembly filters it (dropping + renumbering).
const STEP_MARKER_ONLY = /^[\s\d.)\]\-*+#:]*$/;
export const isContentfulStep = (s: string): boolean =>
  !STEP_MARKER_ONLY.test(s.replace(/\s+/g, " ").trim());

// Asset extensions an Obsidian embed renders inline (image/av/pdf) — NOT a cross-note
// relation. Anchored at `$`, case-insensitive, tested against the alias-stripped target
// (so `![[diagram.png|caption]]` is caught). The single source of truth for the
// asset gate in both harvestWikilinks (embed filter) and harvestInternalLinks.
export const ASSET_RE =
  /\.(png|jpe?g|gif|svg|webp|avif|bmp|ico|mp4|mov|webm|mkv|ogv|3gp|mp3|wav|m4a|ogg|flac|pdf)$/i;

// A markdown-link url is an EXTERNAL citation when it carries a scheme (http:, mailto:,
// tel:, ftp:) or is protocol-relative (//host); everything else is an in-vault relative
// path (a vault edge). Splits harvestExternalLinks (external-only) from harvestInternalLinks.
export const isExternalUrl = (url: string): boolean =>
  /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//");

// The Markdown inline-link grammar `[text](url "title")`, shared by harvestExternalLinks
// and harvestInternalLinks so the two complementary lanes (split by isExternalUrl) can
// never drift. Excludes images (`!` lookbehind) and wikilinks (`]` lookbehind). The url
// group `[^)\s]+` forbids a literal space, so a spaced path must be %20-encoded. Safe to
// share at module scope: String.prototype.matchAll clones the regex, so lastIndex never
// carries between calls.
const MD_LINK_RE = /(?<![!\]])\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

// Strip a trailing `#fragment` (a section/block anchor like `note#heading` or
// `note.md#page=2`) from an edge target BEFORE it is slugged, so an anchored link and
// its bare form harvest to the SAME slug — `[[note#heading]]` and `[x](note.md#heading)`
// both yield `note`, not `note-heading`. Runs OUTSIDE slugSegment (which must keep
// mirroring vault-query slug.rs::segment); the fragment strip is a harvest concern, not
// a slug-grammar one. Shared by both harvest lanes so the two never drift. Without this,
// a fragment-bearing source edge slugged WITH its anchor and read as dropped against an
// output that links the bare note — a wikilinkResidue false positive.
export function normalizeEdgeTarget(raw: string): string {
  return raw.replace(/#.*$/, "");
}

// Harvest every [[wikilink]] (and ![[embed]]) in `text` as {markup, slug, target}:
// `markup` is the verbatim span, `slug` its target slugged for byte-stable comparison,
// `target` the raw alias-stripped endpoint (the collision discriminator wikilinkResidue
// keys on). An alias `[[t|a]]` harvests target `t`; the slug matches emitRelationsBlock's
// pre-slugged file endpoints and a retained block's verbatim link alike, since
// slugSegment is idempotent. ITEM B: an asset embed (`![[diagram.png]]`, `![[doc.pdf#page=2]]`)
// is NOT an edge — it renders inline, so it is skipped here lest it surface as a phantom
// dropped-wikilink; a bare `[[x.png]]` (no `!` embed) and a note transclusion `![[some-note]]`
// or `![[some-note#heading]]` (no asset ext) stay real edges. Part of harvestVaultEdges, the source-of-truth for a note's
// cross-note edges: pipeline.ts::wikilinkResidue diffs source against output over these
// slugs, so an edge the extractor failed to encode — and the prose-fold dissolved —
// surfaces as residue instead of vanishing silently.
export function harvestWikilinks(text: string): VaultEdge[] {
  const out: VaultEdge[] = [];
  for (const m of text.matchAll(/!?\[\[([^\]]+)\]\]/g)) {
    // strip the alias, then the `#fragment` (normalizeEdgeTarget) BEFORE slugging, so
    // `[[note#heading]]` harvests slug `note` — the same slug the bare `[[note]]` and
    // the markdown-link lane yield. The asset gate then runs on the fragment-stripped
    // target (ASSET_RE is `$`-anchored), so a page/section embed `![[doc.pdf#page=2]]`
    // is still caught. slug and target both drop the fragment, so anchored and bare
    // forms unify on the cross-component join key (harvest ↔ emit ↔ coverage).
    const target = normalizeEdgeTarget(m[1].split("|")[0].trim());
    if (m[0].startsWith("!") && ASSET_RE.test(target)) continue;
    const slug = slugSegment(target);
    if (slug) out.push({ markup: m[0], slug, target });
  }
  return out;
}

// Harvest every EXTERNAL [text](url) Markdown link — the citation/source lane (D38),
// distinct from vault edges. Keeps ONLY links whose url is external (isExternalUrl):
// a scheme-less `[x](foo.md)` is a vault edge and moves to harvestInternalLinks. Excludes
// images (![alt](url), rejected by the `!` lookbehind) and wikilinks (the `]` lookbehind
// rejects the `](...)` trailing a `[[..]]` close, and a `[[x]]` has no `(url)` anyway).
// The optional title suffix ([t](url "title")) is tolerated and dropped. The inventory
// key is the URL (the grounding target of a cites/source edge), not a vault slug.
export function harvestExternalLinks(
  text: string,
): { markup: string; text: string; url: string }[] {
  const out: { markup: string; text: string; url: string }[] = [];
  for (const m of text.matchAll(MD_LINK_RE)) {
    const url = m[2].trim();
    if (url && isExternalUrl(url)) out.push({ markup: m[0], text: m[1].trim(), url });
  }
  return out;
}

// Harvest every INTERNAL [text](path) Markdown link — a scheme-less relative path is a
// cross-note edge (D38), the markdown-syntax sibling of a [[wikilink]]. Mirrors
// harvestWikilinks' shape so harvestVaultEdges can concat the two lanes. Shares
// MD_LINK_RE with harvestExternalLinks (so `[^)\s]+` forbids a literal space — a path with
// spaces must be %20-encoded, which the decode step below restores) but keeps only the
// !isExternalUrl matches. Each path is cleaned to a comparable vault target: strip a
// leading `./`, drop a `#fragment`, decode `%20`, then strip a trailing `.md` — so a
// `[x](foo.md)` and a `[[foo]]` yield the SAME target `foo` and never false-collide in
// wikilinkResidue. Skips asset links (ASSET_RE) and a bare `#anchor` (cleans to empty).
// SPECULATIVE LANE: the vault is wikilink-only today (zero scheme-less markdown-link
// callers measured 2026-06-29); this lane exists on spec for a future mixed vault. Kept,
// not deleted, so harvestVaultEdges already unifies both syntaxes the day one appears.
export function harvestInternalLinks(text: string): VaultEdge[] {
  const out: VaultEdge[] = [];
  for (const m of text.matchAll(MD_LINK_RE)) {
    const raw = m[2].trim();
    if (!raw || isExternalUrl(raw)) continue;
    // strip a leading `./` then the `#fragment` (normalizeEdgeTarget) before slugging
    let path = normalizeEdgeTarget(raw.replace(/^\.\//, ""));
    try {
      path = decodeURIComponent(path);
    } catch {
      // malformed %-sequence: keep the raw path (still comparable, just not decoded)
    }
    if (ASSET_RE.test(path)) continue;
    const target = path.replace(/\.md$/i, "");
    const slug = slugSegment(target);
    if (slug) out.push({ markup: m[0], slug, target });
  }
  return out;
}

// The single source of truth for a note's cross-note edges: every [[wikilink]] UNION
// every scheme-less [text](path) markdown link. Both lanes share the VaultEdge shape, so
// wikilinkResidue and the extractor's MUST-COVER inventory consume one unified edge set.
export function harvestVaultEdges(text: string): VaultEdge[] {
  return [...harvestWikilinks(text), ...harvestInternalLinks(text)];
}

// ---- payload harvest: the NON-edge, NON-prose loss surface (the payloadResidue spine) ----
// wikilinkResidue makes a dropped cross-note EDGE loud; these harvesters extend the same
// deterministic move to the five other span classes whose information is LITERAL or
// STRUCTURAL — and therefore unrecoverable from re-authored prose, so distillation is not
// licensed to compress them: verbatim fenced code, verbatim blockquotes, table data rows,
// image/asset embeds, math/formulas, external citations, and substantive statistics. Each
// returns {markup, key}: `markup` is a single-line capped label (the <entry term=…>
// attribute must not carry a newline), `key` a content-signature compared against the SAME
// harvester run over the final output — a span surviving anywhere in output is covered.
// Prose-compressible classes (headings, list items, sub-sections, qualifiers) are
// deliberately OUT: a deterministic test over them would flag every source span the tool
// is licensed to collapse. That residual prose-payload gap is named, not papered over.
export type PayloadSpan = { markup: string; key: string };

// Collapse a span to a single short line for the residue <entry term/source> label.
const oneLine = (s: string, n = 80): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

// Blank every fenced region (``` / ~~~, 3+ markers) line-for-line, preserving line count
// so a caller can align scrubbed lines with raw ones. A `|`, `$`, or digit inside a code
// block is code, never a table cell / formula / statistic, so the number/table/math/citation
// lanes scrub fences first; harvestFences itself owns the fenced class.
function stripFences(text: string): string {
  const out: string[] = [];
  let open: string | null = null;
  for (const line of text.split("\n")) {
    const m = /^[ \t]*(`{3,}|~{3,})/.exec(line);
    if (!open && m) {
      open = m[1][0];
      out.push("");
      continue;
    }
    if (open && m && line.trimStart().startsWith(open.repeat(3))) {
      open = null;
      out.push("");
      continue;
    }
    out.push(open ? "" : line);
  }
  return out.join("\n");
}

// ---- ONE structural detection, N uses (D2) ----
// Byte length of a string in UTF-8 (spans are byte offsets into the source Buffer, never JS
// UTF-16 indices — the Cyrillic invariant).
const byteLen = (s: string): number => Buffer.byteLength(s, "utf8");

// Per-line byte start offsets for a text split on "\n" (each line's start + its own byte
// length + 1 for the newline). Aligns a raw line index with its byte span.
function lineByteOffsets(text: string): number[] {
  const lines = text.split("\n");
  const off = new Array<number>(lines.length);
  let acc = 0;
  for (let i = 0; i < lines.length; i++) {
    off[i] = acc;
    acc += byteLen(lines[i]) + 1;
  }
  return off;
}

// Flatten the mdstruct headings tree to a flat list in tree order (parent before children),
// reusing mdstruct's walkHeadings so the traversal lives in one place.
function flattenHeadings(hs: Heading[] | undefined): Heading[] {
  const out: Heading[] = [];
  walkHeadings(hs, (h) => out.push(h));
  return out;
}

// The categorized structural payload of a parsed doc, harvested ONCE. structuralSpans composes
// the flat byte-span union from it (the router mask); each of the four structural harvesters
// reads the category it owns and applies its own key-normalization (the residue inventory).
// One detection, N uses (D2): the router and the inventory can never disagree on what is
// structural. Blockquotes are top-level only (nested `> >` merged, matching the regex `>`-run);
// every other lane descends fully (a fence/table inside a quote or list still counts).
interface StructuralParts {
  fences: MdNode[]; // fenced codeBlocks (bodySpan = inner body)
  blockquotes: MdNode[]; // top-level blockQuote nodes
  tables: MdNode[]; // GFM table nodes (span covers header + delimiter + data rows)
  tableRows: MdNode[]; // GFM tableRow nodes (children = tableCell), document order
  images: MdInline[]; // markdown image inlines + asset-embed wikilink inlines
  // delimiter-less pseudo-table rows outside any real table; raw = source line, masked = the
  // fence/inline-span-masked line (both precomputed here so harvestTableRows never re-splits).
  pseudoRows: { span: Span; raw: string; masked: string }[];
}

// collectStructural memoized per ParsedDoc: the four harvesters + structuralSpans all read the
// same parse (parseDoc caches by text → one ParsedDoc object), so the walk runs once per doc,
// not once per consumer. Nothing mutates StructuralParts, so sharing the object is safe.
const structuralCache = new WeakMap<ParsedDoc, StructuralParts>();

function collectStructural(parsed: ParsedDoc): StructuralParts {
  const cached = structuralCache.get(parsed);
  if (cached) return cached;
  const { doc, buf } = parsed;
  const parts: StructuralParts = {
    fences: [],
    blockquotes: [],
    tables: [],
    tableRows: [],
    images: [],
    pseudoRows: [],
  };
  // Full-descent walk: fences, tables (+ their line ownership), and tableRows in document order.
  const tableLines = new Set<number>(); // 1-indexed lines owned by a real table (local bookkeeping)
  walkNodes(doc.nodes, (n) => {
    if (n.type === "codeBlock" && n.fenced) parts.fences.push(n);
    if (n.type === "table") {
      parts.tables.push(n);
      if (n.startLine != null && n.endLine != null)
        for (let ln = n.startLine; ln <= n.endLine; ln++) tableLines.add(ln);
    }
    if (n.type === "tableRow") parts.tableRows.push(n);
  });
  // Top-level blockquotes only: noDescend so a nested `> >` quote is not double-counted.
  walkNodes(
    doc.nodes,
    (n) => {
      if (n.type === "blockQuote") parts.blockquotes.push(n);
    },
    new Set(["blockQuote"]),
  );
  // Inline image lane: every markdown image, plus a wikilink embed whose target is an asset
  // (the same ASSET_RE filter harvestImages / the old embed-mask regex applied). Inlines inside
  // code spans/fences are not emitted by mdstruct, so a `![[x.png]]` in inline code is skipped.
  for (const il of doc.inlines ?? []) {
    if (il.type === "image") parts.images.push(il);
    else if (il.type === "wikilink" && il.embed && il.page != null) {
      const t = normalizeEdgeTarget(il.page.split("|")[0].trim());
      if (ASSET_RE.test(t)) parts.images.push(il);
    }
  }
  // Pseudo-table fallback (class-1 carve-out): a `- a | b` row has no `:?-+:?` delimiter, so
  // comrak emits no table node — the old regex row-scan must keep catching it, restricted to
  // lines OUTSIDE any real mdstruct table (tableLines) so a genuine row is never double-owned.
  const text = buf.toString("utf8");
  const rawLines = text.split("\n");
  const off = lineByteOffsets(text);
  const probe = stripFences(text).replace(MASK_RE, " ").split("\n");
  for (let i = 0; i < probe.length; i++) {
    if (tableLines.has(i + 1)) continue;
    if (!isTableDataRow(probe[i])) continue;
    parts.pseudoRows.push({
      span: [off[i], off[i] + byteLen(rawLines[i])],
      raw: rawLines[i],
      masked: probe[i],
    });
  }
  structuralCache.set(parsed, parts);
  return parts;
}

// The union of source byte-spans for the structural payload lanes — fenced code, tables
// (mdstruct table spans ∪ the pseudo-table regex fallback), blockquotes, images, asset embeds.
// The SINGLE detection both consumers read: payloadMask blanks these bytes for the router
// signal; the four harvesters read collectStructural's categories for the residue inventory.
export function structuralSpans(parsed: ParsedDoc): Span[] {
  const parts = collectStructural(parsed);
  const spans: Span[] = [];
  for (const n of parts.fences) if (n.span) spans.push(n.span);
  for (const n of parts.blockquotes) if (n.span) spans.push(n.span);
  for (const n of parts.tables) if (n.span) spans.push(n.span);
  for (const il of parts.images) if (il.span) spans.push(il.span);
  for (const r of parts.pseudoRows) spans.push(r.span);
  return spans;
}

// Verbatim fenced code/output blocks. key = the inner body, each line right-trimmed,
// leading/trailing blank lines dropped — the language tag and fence width are excluded, so
// a retained block (assembleBody pushes b.text verbatim) covers its source twin regardless
// of info-string. Internal whitespace is KEPT: code indentation is load-bearing.
// Fenced-ONLY: comrak also emits indented code blocks the old regex never saw, so
// collectStructural.fences is fenced-only. Fixes the nested-fence mis-split — the old
// line-scanner closed the block at the FIRST inner ` ``` `; comrak parses the outer block whole.
export function harvestFences(text: string): PayloadSpan[] {
  const out: PayloadSpan[] = [];
  const parsed = parseDoc(text);
  const { buf } = parsed;
  for (const n of collectStructural(parsed).fences) {
    if (!n.bodySpan) continue;
    const key = sliceBytes(buf, n.bodySpan)
      .split("\n")
      .map((l) => l.replace(/\s+$/, ""))
      .join("\n")
      .replace(/^\n+|\n+$/g, "");
    if (key) out.push({ markup: oneLine(sliceBytes(buf, n.span ?? n.bodySpan)), key });
  }
  return out;
}

// Verbatim blockquotes (`>`-prefixed runs) — a deliberate literal quotation, especially a
// non-English source citation, the tool may not reword. key = inner text, whitespace
// collapsed, lowercased; a quote re-authored into bare prose (no `>`) is not covered → a
// loud, correct residue. A retained blockquote keeps its `>`, so it covers its source twin.
// A `>`-prefixed blockquote line, capturing its inner text. Shared by harvestBlockquotes
// (payload inventory) and payloadMask (router signal) — one detection, two uses (D2).
export const BLOCKQUOTE_LINE = /^\s*>+\s?(.*)$/;

// mdstruct `blockQuote` nodes, no-descend (the regex merged a `>`/`>>` run into ONE key, so
// nested quotes must not be double-counted). Fixes two regex bugs: a `> quote` INSIDE a code
// fence no longer false-flags (comrak ignores fenced content), and a list-nested `- > quote`
// is now captured (the old `^\s*>` line-anchor missed it; comrak parses it as a child quote).
export function harvestBlockquotes(text: string): PayloadSpan[] {
  const out: PayloadSpan[] = [];
  const parsed = parseDoc(text);
  const { buf } = parsed;
  for (const n of collectStructural(parsed).blockquotes) {
    if (!n.span) continue;
    const inner: string[] = [];
    for (const line of sliceBytes(buf, n.span).split("\n")) {
      const m = BLOCKQUOTE_LINE.exec(line);
      if (m) inner.push(m[1]);
    }
    const key = inner.join(" ").replace(/\s+/g, " ").trim().toLowerCase();
    if (key) out.push({ markup: oneLine(inner.join(" ")), key });
  }
  return out;
}

// GFM pipe-table DATA rows — structured payload the tool dissolves into prose. Runs on a
// fence- and inline-span-masked copy (MASK_RE blanks wikilinks/embeds/inline-code) so a
// prose line bearing a `[[a|b]]` alias pipe or a code-fence pipe is never mis-read as a row,
// then maps each surviving row back to its raw line for the label. key = trimmed lowercased
// cells joined on an unlikely separator (the row payload, order-preserving). The delimiter
// row (every cell `:?-+:?`) and all-empty rows are skipped.
// Split a fence- and inline-span-masked table line into trimmed cells (outer pipes dropped,
// `\|` kept literal). The shared cell decomposition behind both the data-row predicate and
// the harvested key.
function tableCells(maskedLine: string): string[] {
  return maskedLine
    .trim()
    .replace(/^\||\|$/g, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());
}

// A fence- and inline-span-masked line is a GFM table DATA row: it carries a pipe, splits
// into ≥2 non-empty cells, and is not the `:?-+:?` delimiter row. One detection, two uses
// (D2): harvestTableRows inventories the payload, payloadMask blanks it for the router signal.
export function isTableDataRow(maskedLine: string): boolean {
  if (!maskedLine.includes("|")) return false;
  const cells = tableCells(maskedLine);
  if (cells.length < 2 || cells.every((c) => c === "")) return false;
  if (cells.every((c) => /^:?-+:?$/.test(c))) return false; // delimiter row
  return true;
}

// HYBRID — the one non-clean lane. Real GFM tables come from mdstruct `tableRow`→`tableCell`
// spans (header row kept; the delimiter row comrak never emits). A `- a | b` pseudo-table has
// no delimiter row, so comrak emits no table node — the old regex row-scan must keep catching
// it, UNIONed in for rows outside any mdstruct table. A real table's lines go in `covered` so
// a genuine row is never counted by both paths.
export function harvestTableRows(text: string): PayloadSpan[] {
  const out: PayloadSpan[] = [];
  const parsed = parseDoc(text);
  const { buf } = parsed;
  const parts = collectStructural(parsed);
  for (const n of parts.tableRows) {
    const cells = (n.children ?? []).map((c) =>
      c.span ? sliceBytes(buf, c.span).replace(MASK_RE, " ").trim().toLowerCase() : "",
    );
    if (cells.length && !cells.every((c) => c === "")) {
      out.push({
        markup: oneLine((n.span ? sliceBytes(buf, n.span) : cells.join(" | ")).trim()),
        key: cells.join("␟"),
      });
    }
  }
  // Pseudo-table fallback: rows outside any real mdstruct table (parts.pseudoRows), keyed
  // exactly as the old regex row-scan did (masked cells, lowercased). raw/masked are precomputed
  // in collectStructural — the same detection, not a second fence/mask pass.
  for (const { raw, masked } of parts.pseudoRows) {
    out.push({
      markup: oneLine(raw.trim()),
      key: tableCells(masked)
        .map((c) => c.toLowerCase())
        .join("␟"),
    });
  }
  return out;
}

// Images + Obsidian asset embeds — the inline-render lane harvestWikilinks SKIPS, so today
// a dropped image falls through BOTH gates. Markdown `![alt](url)` keyed by url slug; asset
// embed `![[x.png]]` (ASSET_RE) keyed by target slug. Both fragment-stripped + decoded, so
// an embed surviving in a retained block covers its source twin.
// mdstruct `inlines[]` (via collectStructural.images) — a markdown `image.url` or a
// `wikilink{embed}` asset target (`page`), each slugged. Fixes the payload-in-code false
// positive: an `![[x.png]]` / `![alt](y.png)` inside inline code or a fence is no longer
// emitted (comrak surfaces no image inline there), so it stops false-flagging as dropped.
// On `page` vs `target`, see MdInline in mdstruct.ts.
export function harvestImages(text: string): PayloadSpan[] {
  const out: PayloadSpan[] = [];
  const parsed = parseDoc(text);
  const { buf } = parsed;
  for (const il of collectStructural(parsed).images) {
    if (il.type === "image" && il.url != null) {
      let u = normalizeEdgeTarget(il.url.trim());
      try {
        u = decodeURIComponent(u);
      } catch {
        // malformed %-sequence: keep raw (still a comparable key)
      }
      const key = slugSegment(u);
      if (key) out.push({ markup: oneLine(il.span ? sliceBytes(buf, il.span) : il.url), key });
    } else if (il.type === "wikilink" && il.page != null) {
      // collectStructural already filtered these to embed + ASSET_RE; just slug the target.
      const t = normalizeEdgeTarget(il.page.split("|")[0].trim());
      const key = slugSegment(t);
      if (key) out.push({ markup: oneLine(il.span ? sliceBytes(buf, il.span) : il.page), key });
    }
  }
  return out;
}

// Math / formulas — literal non-prose-compressible payload by the same criterion as fenced
// code. Display math (`$$…$$`, `\[…\]`, `\(…\)`) is unambiguous. Inline `$…$` is admitted
// ONLY when the span carries a math operator AND is not a pure number, so a currency span
// (`$1.52 trillion`, two separate `$5 … $10` mentions) is never mis-read as a formula. key
// = symbol body, whitespace stripped, lowercased.
const MATH_OP =
  /[=<>+\-*/^_{}\\]|\\(?:le|ge|leq|geq|neq|cdot|times|frac|sum|prod|int|sqrt|approx|propto|to)\b/;
// Display-math spans (`$$…$$`, `\[…\]`, `\(…\)`), inner captured, multiline. Shared by
// harvestMath (payload inventory) and payloadMask (router signal) — one detection, two uses (D2).
export const DISPLAY_MATH_PATTERNS = [
  /\$\$([\s\S]+?)\$\$/g,
  /\\\[([\s\S]+?)\\\]/g,
  /\\\(([\s\S]+?)\\\)/g,
];
export function harvestMath(text: string): PayloadSpan[] {
  const out: PayloadSpan[] = [];
  const src = stripFences(text);
  const push = (markup: string, inner: string) => {
    const key = inner.replace(/\s+/g, "").toLowerCase();
    if (key) out.push({ markup: oneLine(markup), key });
  };
  for (const re of DISPLAY_MATH_PATTERNS) for (const m of src.matchAll(re)) push(m[0], m[1]);
  const noDisplay = src.replace(DISPLAY_MATH_PATTERNS[0], " ");
  for (const m of noDisplay.matchAll(/(?<![\d\\$])\$([^$\n]+?)\$(?![\d$])/g)) {
    const inner = m[1];
    if (!MATH_OP.test(inner)) continue; // no operator → a currency/number span, not a formula
    if (/^[\s\d.,]+$/.test(inner)) continue;
    push(m[0], inner);
  }
  return out;
}

// External citations — the source/grounding links wikilinkResidue never covered (they are
// not vault edges). Unions the three forms the vault actually uses: markdown `[text](url)`,
// footnote definitions `[^id]: url` (which harvestExternalLinks never sees), and bare/
// autolink URLs. Fences scrubbed first (a URL in a code sample is not a citation). key =
// the URL, lowercased, trailing punctuation trimmed.
export function harvestCitations(text: string): PayloadSpan[] {
  const out: PayloadSpan[] = [];
  const src = stripFences(text);
  const push = (markup: string, url: string) => {
    const u = url.trim().replace(/[.,;:)\]>]+$/, "");
    if (u && /^(?:https?|ftp):\/\//i.test(u))
      out.push({ markup: oneLine(markup), key: u.toLowerCase() });
  };
  for (const l of harvestExternalLinks(src)) push(l.markup, l.url);
  for (const m of src.matchAll(/^[ \t]*\[\^[^\]]+\]:\s*(\S+)/gm)) push(m[0].trim(), m[1]);
  for (const m of src.matchAll(/<((?:https?|ftp):\/\/[^>\s]+)>/gi)) push(m[0], m[1]);
  for (const m of src.matchAll(/(?<![("<\]])\b(?:https?|ftp):\/\/[^\s)\]>]+/gi)) push(m[0], m[0]);
  return out;
}

// Substantive numeric statistics — a figure prose cannot recover. Scrubbed first (fences,
// footnote-definition lines, autolinks, URLs, markdown-link/image targets, MASK_RE spans)
// so a digit inside a URL path, a footnote id, or inline code is never harvested as a
// phantom statistic. SUBSTANCE GATE: keep a token only when it bears %, $, a decimal,
// comma-grouping, or a ≥2-digit run; bare single digits (step 1, v2, [1]) are idiom. A bare
// 4-digit year (1900–2099) is dropped UNLESS a scale word follows it, so `2024` is not a
// statistic but `2024 deaths`-style stays. Multipliers (`8x`, `2x`, `8-fold`) — the form
// GitClear/Faros findings use, which the substance gate alone would drop — are a sub-lane.
const NUM_RE = /(?<![\w.])\$?\d[\d,]*(?:\.\d+)?%?/g;
const MULT_RE = /\b\d+(?:\.\d+)?\s*(?:x|×|-?fold)\b/gi;
const SCALE_WORD =
  /^\W*(trillion|billion|million|thousand|hundred|percent|deaths|cases|people|users)\b/i;
function scrubForNumbers(text: string): string {
  return stripFences(text)
    .replace(/^[ \t]*\[\^[^\]]+\]:.*$/gm, " ") // footnote definitions (incl their URLs)
    .replace(/<[^>\s]+>/g, " ") // autolinks
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ") // scheme://… URLs
    .replace(/\]\([^)\s]+\)/g, "]()") // markdown link/image targets
    .replace(MASK_RE, " "); // wikilinks/embeds/inline-code
}
export function harvestNumbers(text: string): PayloadSpan[] {
  const out: PayloadSpan[] = [];
  const clean = scrubForNumbers(text);
  for (const m of clean.matchAll(MULT_RE)) {
    out.push({ markup: m[0].trim(), key: m[0].replace(/\s+/g, "").toLowerCase() });
  }
  for (const m of clean.matchAll(NUM_RE)) {
    const tok = m[0];
    const intRun = tok.replace(/[$,%]/g, "").split(".")[0];
    const marked = /[%$.]/.test(tok) || /\d,\d/.test(tok);
    if (!marked && intRun.length < 2) continue; // bare single digit → idiom
    if (!marked && /^(?:19|20)\d\d$/.test(intRun)) {
      const after = clean.slice((m.index ?? 0) + tok.length, (m.index ?? 0) + tok.length + 16);
      if (!SCALE_WORD.test(after)) continue; // bare year, no scale word → not a statistic
    }
    out.push({ markup: tok, key: tok.replace(/[$,]/g, "") });
  }
  return out;
}

// ---- prose-list-item inventory (the prose-judge tier, Backlog 40 / D46) ----
// The payload spine above catches LITERAL/STRUCTURAL loss but is blind to a dropped pure-
// prose list-item — a `Признаки нарушения` bullet, a `Шаблоны` pattern, an F1–F7 enumerated
// claim — and so are the fidelity/workflow gates (they only judge the defs and steps the
// extractor lifted). This harvester does NOT decide coverage; it only enumerates the must-
// cover CLASS (explicit list-items under a depth≥2 heading) as an answer key for the glm
// matcher (pipeline.ts::runProseGate). A list-item is an ATOMIC enumerated claim, not
// restatement-collapsible prose, which is why per-item judging is false-flag-free where a
// coarse prose-span judge is not — worked examples, thesis spans, and heading-less essays
// stay deferred. Four deterministic exclusions narrow the inventory to must-cover items;
// none is a meaning judgment — the layer enumerates and excludes, it never declares survival.
export type ProseUnit = { id: string; heading: string; depth: number; span: string };

// Lowercase, strip markdown punctuation, collapse whitespace — a containment-comparable
// form shared by EXCLUSION-3 (extractor-claimed) here and the anchor relevance re-check in
// the matcher (pipeline.ts::anchored).
export const normalizeForContainment = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[`*_>#|[\]()!~-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export function harvestProseListItems(text: string, claimed: string[]): ProseUnit[] {
  const claimNorm = claimed.map(normalizeForContainment).filter((c) => c.length > 0);
  const lines = text.split("\n");
  const units: ProseUnit[] = [];
  let inFence = false;
  let tok = "";
  let curHeading = "";
  let curDepth = 0;
  let sawHeading = false;
  let n = 0;
  const HEAD = /^(#{2,6})\s+(.*)$/;
  // markdown bullets (- * +), numbered (1. / 1)), and the A–F / Cyrillic enum markers the
  // vault's scenario / moat / worked-example lists use (F1. A) Сценарий-Б.). The uppercase
  // A–F restriction keeps a prose abbreviation ("e.g.") from registering as a list marker.
  const ITEM = /^\s*(?:[-*+]|\d+[.)]|[A-FА-Я]\d*[.)])\s+(.*\S)\s*$/;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const f = /^\s*(`{3,}|~{3,})/.exec(ln);
    if (f) {
      if (!inFence) {
        inFence = true;
        tok = f[1][0];
      } else if (ln.includes(tok.repeat(3))) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;
    const h = ln.match(HEAD);
    if (h) {
      curDepth = h[1].length;
      curHeading = h[2];
      sawHeading = true;
      continue;
    }
    if (!sawHeading) continue; // EXCL-1 intro/thesis-owned lead (before the first ## heading)
    const m = ln.match(ITEM);
    if (!m) continue;
    let body = m[1];
    // gather deeper-indented continuation lines (a wrapped item) into one span
    while (
      i + 1 < lines.length &&
      /^\s+\S/.test(lines[i + 1]) &&
      !ITEM.test(lines[i + 1]) &&
      !HEAD.test(lines[i + 1])
    ) {
      body += " " + lines[++i].trim();
    }
    // EXCL-2 payload/spine-owned: a bullet that is wholly a wikilink / image / table row /
    // citation / inline-code / number is already covered by the seven payload lanes — strip
    // those and require residual prose before inventorying.
    const probe = stripFences(body)
      .replace(MASK_RE, " ")
      .replace(/!\[[^\]]*\]\([^)]*\)|!\[\[[^\]]+\]\]/g, " ")
      .replace(/^\s*\|.*\|?\s*$/g, " ");
    if (!/\S/.test(probe)) continue;
    const norm = normalizeForContainment(body);
    if (norm.length < 12) continue; // EXCL-4 too thin to carry a claim (heading echo, scaffold)
    // EXCL-3 extractor-claimed: the item was folded into a def or step the extractor lifted,
    // so fidelityGate/workflowGate already judge it. Information-grounded (the extractor's own
    // source attribution), a best-effort REDUCER — a non-contiguously cited item may slip to
    // the matcher, costing a token, never a false residue.
    if (claimNorm.some((c) => c.includes(norm))) continue;
    units.push({
      id: `${slugSegment(curHeading) || "prose"}-${n++}`,
      heading: oneLine(curHeading, 60),
      depth: curDepth,
      span: oneLine(body, 300),
    });
  }
  return units;
}

// ---- per-section density router (D12/D2; the --dry-run + Backlog 10 spine) ----
// The up-front classification: split a note into heading-delimited sections and route each
// on its own payload density (D12 per-section grain). Density is the harvest applied a THIRD
// way (D2 "one harvest, three uses"): the same structural-payload detection that feeds the
// residue gate and the protected-span set is reused here to MASK payload and measure the
// prose word-share that remains. High payload-share → preserve (structural compaction); low
// → re-author (compact prose). Deterministic and free — no LLM, no model consulted.
export type Section = { heading: string; depth: number; text: string };
export type Route = "re-author" | "preserve";

// Starting threshold only — the real value is calibrated against 00 inbox/ via --dry-run
// (Backlog 7/9). A section whose payload word-share meets τ routes to preserve.
export const DEFAULT_TAU = 0.5;

// ATX heading grammar (marker + title, trailing `#` markers stripped). sections() no longer
// uses it — it reads mdstruct headings — but extractSection (the `## Relations`/`## Glossary`
// REBUILD toggle) still scans for ATX headings on a fence-masked copy, so it stays here.
const ATX_HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

// Split on every mdstruct heading (ATX depth 1–6 or setext), in document order. Heading
// detection now comes from mdstruct: a fenced OR frontmatter `#`-comment is never a heading
// (the frontmatter fix), and a setext underline is recognized (the regex scanner saw neither).
// The lead before the first heading is the intro section (heading "", depth 0), dropped when
// blank. Each section's text is its own heading line plus every following non-heading line up
// to the next heading's start — a DISJOINT body (mdstruct's sectionSpan NESTS, so a parent
// would swallow its children; it is not read). `heading` is the title via textSpan, `depth`
// the heading level. The line-join reproduces the old scanner's exact trailing-newline bytes,
// so only the heading oracle changed.
export function sections(text: string): Section[] {
  const { doc, buf } = parseDoc(text);
  const lines = text.split("\n");
  const heads = flattenHeadings(doc.headings)
    .filter((h) => h.startLine != null)
    .sort((a, b) => a.startLine! - b.startLine!);
  const bound = (idx: number) => (idx < heads.length ? heads[idx].startLine! - 1 : lines.length);
  const out: Section[] = [];
  const intro = lines.slice(0, bound(0)).join("\n"); // lead before the first heading
  if (/\S/.test(intro)) out.push({ heading: "", depth: 0, text: intro });
  for (let i = 0; i < heads.length; i++) {
    out.push({
      heading: sliceBytes(buf, heads[i].textSpan).trim(),
      depth: heads[i].level,
      text: lines.slice(bound(i), bound(i + 1)).join("\n"),
    });
  }
  return out;
}

// Blank the structural payload spans (structuralSpans: fenced code, tables, blockquotes,
// images, asset embeds) — every non-newline byte of a span → space, so the masked copy keeps
// its line count and aligns with the source. Then the display-math lane blanks in place. ONE
// detection with the residue gate (D2): the router reads exactly what the harvesters inventory.
// STRUCTURAL-ONLY — no inline-code output lane: MASK_RE is applied only inside collectStructural's
// pseudo-table detection probe, never to the returned mask (as the old per-line version applied
// MASK_RE only to its rowProbe copy). Display math stays regex; the lane set is unchanged.
export function payloadMask(text: string): string {
  const parsed = parseDoc(text);
  const bytes = Buffer.from(parsed.buf); // copy — never mutate the cached parse buffer
  for (const [s, e] of structuralSpans(parsed))
    for (let i = s; i < e && i < bytes.length; i++) if (bytes[i] !== 0x0a) bytes[i] = 0x20;
  let masked = bytes.toString("utf8");
  const blankKeepingLines = (str: string, re: RegExp) =>
    str.replace(re, (m) => m.replace(/[^\n]/g, " "));
  for (const re of DISPLAY_MATH_PATTERNS) masked = blankKeepingLines(masked, re);
  return masked;
}

// Payload word-share ∈ [0,1]: the fraction of a section's words that live in structural
// payload, = (words − words(payloadMask)) / words. 0 when the section has no words.
export function payloadDensity(text: string): number {
  const total = wordCount(text);
  if (!total) return 0;
  const prose = wordCount(payloadMask(text));
  return (total - prose) / total;
}

// Route a section on its density: density ≥ τ → preserve, else re-author.
export function routeSection(text: string, tau: number = DEFAULT_TAU): Route {
  return payloadDensity(text) >= tau ? "preserve" : "re-author";
}

// One routed section: its heading/depth plus the computed density and route. The dry-run
// row — pure data, no I/O.
export type SectionRoute = { heading: string; depth: number; density: number; route: Route };

// Segment a note and route every section on its own density (D12 per-section grain).
export function routeNote(text: string, tau: number = DEFAULT_TAU): SectionRoute[] {
  return sections(text).map((s) => {
    const density = payloadDensity(s.text);
    return {
      heading: s.heading,
      depth: s.depth,
      density,
      route: density >= tau ? "preserve" : "re-author",
    };
  });
}

// Render a note's routed sections as a deterministic dry-run report: a note line
// (`path · N re-author / M preserve`) then one indented line per section
// (`heading · density · route`); the unnamed intro section prints as `(intro)`.
export function formatDryRun(path: string, rows: SectionRoute[]): string {
  const re = rows.filter((r) => r.route === "re-author").length;
  const pr = rows.length - re;
  const head = `${path} · ${re} re-author / ${pr} preserve`;
  const body = rows.map(
    (r) => `  ${r.heading || "(intro)"} · ${r.density.toFixed(2)} · ${r.route}`,
  );
  return [head, ...body].join("\n");
}

// ---- per-section build partition (D12/D16; Backlog 10) ----
// One routed build unit: a top-level section (its heading line + body) with the route
// the build acts on — re-author (folds into the one compact head) or preserve (held by
// compactSection). Carries heading/depth so reassembly can demote a structural-name clash.
export type RoutedSection = { heading: string; depth: number; text: string; route: Route };

// Partition a note for the per-section build: lift the leading H1 as the note title
// (emitted first, independent of any section's route — fix #1), then route each remaining
// top-level section. Sections deeper than the top level fold into their parent unit so a
// payload subsection is never torn from its prose parent (fix #2). Pure; no I/O, no model.
export function partition(
  text: string,
  tau: number = DEFAULT_TAU,
): { title: string; sections: RoutedSection[] } {
  let secs = sections(text);
  let title = "";
  // A leading `# Title` is the note title, not a routable unit: lift its heading line out
  // and keep any prose beneath it as a depth-0 intro unit.
  if (secs[0]?.depth === 1 && /^#\s/.test(secs[0].text)) {
    const [first, ...rest] = secs[0].text.split("\n");
    title = first.trim();
    const body = rest.join("\n");
    secs = (/\S/.test(body) ? [{ heading: "", depth: 0, text: body }] : []).concat(secs.slice(1));
  }
  // Group into top-level units: a depth-0 intro stands alone; a heading deeper than the
  // current unit's anchor depth folds into it (keeping a subsection with its parent, fix #2);
  // any other heading opens a new unit. Route is computed over the whole folded unit text.
  const grouped: { heading: string; depth: number; text: string }[] = [];
  let cur: { heading: string; depth: number; text: string } | null = null;
  for (const s of secs) {
    if (cur && cur.depth > 0 && s.depth > cur.depth) {
      cur.text += "\n" + s.text;
    } else {
      cur = { heading: s.heading, depth: s.depth, text: s.text };
      grouped.push(cur);
    }
  }
  const routed: RoutedSection[] = grouped.map((u) => ({ ...u, route: routeSection(u.text, tau) }));
  return { title, sections: routed };
}

// Structurally compact a preserve (payload-dense) unit. v1 is identity passthrough: the
// payload — code, tables, exact numbers — is held byte-verbatim (D16 forbids paraphrase).
// Lossy row/boilerplate dropping is deferred to v2, which must surface each drop out-of-band
// (payloadResidue marks a key covered if it survives anywhere, so a key-collision delete
// would be silent — the unsafe path this v1 declines to take).
export function compactSection(text: string): string {
  return text;
}

// Reassemble the per-section build into one note: the lifted title first (fix #1), then the
// single re-author head (its one prose → ## Workflow → ## Glossary → ## Relations), then the
// compacted preserve sections in source order (fix #4 — head-first is the accepted v1 shape:
// the head is an aggregate with no single source position, so order is honored where defined,
// among the preserves). A preserve heading that collides with a structural H2 name
// (## Glossary/Workflow/Relations) is demoted one level so the note carries exactly one of each
// and the render-mode inverse (parseDistilled) still finds the head's. Pure; no I/O, no model.
const STRUCT_HEAD = /^##\s+(glossary|workflow|relations)\b/i;
export function reassembleNote(title: string, head: string, preserves: string[]): string {
  const demote = (t: string) =>
    t
      .split("\n")
      .map((l) => (STRUCT_HEAD.test(l) ? "#" + l : l))
      .join("\n");
  const parts: string[] = [];
  if (title.trim()) parts.push(title.trim());
  if (head.trim()) parts.push(head.trim());
  for (const p of preserves) if (p.trim()) parts.push(demote(p.trim()));
  return parts.join("\n\n");
}

// a block carries operational tokens that must survive verbatim — code, CLI
// flags, file paths. Used by the wikilink clamp to choose retain over distill.
export const hasOperational = (text: string): boolean =>
  /```|`[^`\n]+`|\s--?[a-z]/i.test(text) || /(^|\s)(\/|~\/|\.\/)\S+/.test(text);

// Reference spans the revise passes must keep verbatim and that never need
// rewording: wikilinks, embeds (![[...]]), and inline code. They are masked to
// opaque ⟦N⟧ tokens for the duration of revise, then restored (see revise()).
export const MASK_RE = /!?\[\[[^\]]+\]\]|`[^`\n]+`/g;

// Deterministic typographic normalization — owned by writing/typography.ts (the
// core), re-exported here so text.ts's existing importers (pure.test.ts:35 and
// every internal user below) keep working unchanged.
export { normalizeTypography } from "./writing/typography.ts";

// Slug a single label — TS-native mirror of vault-query slug.rs::segment /
// normalize_segment (the unified slugifier). Strip wikilink syntax (keeping an
// alias over its target), drop backtick/`*`/`_`, lowercase, collapse every run of
// non-alphanumerics (Unicode letters+digits, so Cyrillic survives) to a single
// `-`, trim leading/trailing `-`. A second cross-language duplication (REL_REGISTRY
// is the first); the round-trip fixture pins it. BUILD emits PRE-slugified labels so
// the `## Relations` block is byte-stable for the REBUILD parser.
export function slugSegment(s: string): string {
  const stripped = s.replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_m, target, alias) =>
    alias != null && alias !== "" ? alias : target,
  );
  return stripped
    .replace(/[`*_]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

// Render a structural relation as readable `rel :: to (predicate)` for the
// prose-synth prompts — they only need a human-readable form of the edge, not the
// emit grammar. Used wherever relations were previously joined as bare strings.
export const relText = (r: Relation): string =>
  `${r.rel} :: ${r.to}${r.predicate ? ` (${r.predicate})` : ""}`;

// Coerce one extracted relation into a typed edge. LOSSY (D29): keep every
// well-formed edge — drop ONLY when `rel` or `to` is missing. An unknown rel or an
// unresolved endpoint is a REBUILD lint finding, never a BUILD drop. Relations skip
// revise(), so typography is normalized here. The rel is lowercased and hyphenated
// (residual space-forms like "precondition for" → "precondition-for") so the open
// token matches the registry's shape; predicate is null when empty.
export function normalizeRelation(r: unknown): Relation | null {
  if (!r || typeof r !== "object") return null;
  const o = r as { rel?: unknown; to?: unknown; predicate?: unknown; quote?: unknown };
  const rel = normalizeTypography(String(o.rel ?? ""))
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
  const to = normalizeTypography(String(o.to ?? "")).trim();
  if (!rel || !to) return null;
  const pred = o.predicate == null ? "" : normalizeTypography(String(o.predicate)).trim();
  // `quote` is the span-locate anchor: trim only, NEVER normalizeTypography — it must
  // stay byte-verbatim so it round-trips against the source in locate(). Omitted when
  // empty so the returned edge matches the two-channel shape when no quote is emitted.
  const quote = typeof o.quote === "string" ? o.quote.trim() : "";
  return { rel, to, predicate: pred || null, ...(quote ? { quote } : {}) };
}

// ---- relations/glossary REBUILD (W1; inverts assemble.ts::emitRelationsBlock /
// assembleBody's Glossary table). Lives here, not cards/, so cards/ modules read an
// emitted note's structural channels through one leaf-module seam (D13). ----

// One structural edge parsed off a `## Relations` list item. `from` is the entry's
// own slug (multi-node form) or null (single-atom form omits the from-label, D26).
// `to` keeps the endpoint's EMITTED form verbatim — `[[file-slug]]` stays bracketed,
// a bare term-slug stays bare — so a caller that re-emits via emitRelationsBlock
// (which itself re-derives scope from the brackets) round-trips byte-for-byte.
export type ParsedRelationEdge = {
  from: string | null;
  rel: string;
  to: string;
  predicate: string | null;
};

// Toggle-based section extraction: an H2 heading whose slugged text equals `name`
// opens the section; ANY other heading (any depth) closes it; `collecting` is
// recomputed on every heading rather than latched, so a same-named H2 appearing
// again later reopens the section. Heading detection runs on a fence-masked copy so
// a fenced `# comment` cannot toggle the section (the sections() fix, d06c6fa) while
// the returned text keeps the RAW lines (fences intact) for the caller to re-scan.
//
// DIVERGENCE from vault-query's canonical rule (relations.rs::parse_relations /
// markdown::heading_text), which opens on ANY depth 1-6: this is the REBUILD inverse
// of assembleBody's emit grammar, whose channels are exactly `## Glossary` /
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

// Parse one `## Relations` list-item body (the text after the `- `/`* ` marker):
// `[<from> ]<rel>:: <to>[ (<predicate>)]`. Lossy (D29): returns null on anything
// short of well-formed rather than throwing — a missing `::`, an empty rel/endpoint,
// or an all-parenthetical tail with no endpoint before it.
function parseEdgeLine(edgeText: string): ParsedRelationEdge | null {
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
// REBUILD inverse of assemble.ts::emitRelationsBlock. Grammar mirrors
// vault-query/src/commands/lint/relations.rs::parse_relations line-for-line (fence
// tracking, heading toggle, `- `/`* ` list-item prefix, `::` split); see splitPredicate
// for the one intentional divergence. Lossy-tolerant like normalizeRelation: a
// malformed line yields no edge and parsing never throws.
export function parseRelationsBlock(md: string): ParsedRelationEdge[] {
  const edges: ParsedRelationEdge[] = [];
  let fence: string | null = null;
  for (const raw of extractSection(md, "relations").split("\n")) {
    const trimmed = raw.trimStart();
    const fm = /^(`{3,}|~{3,})/.exec(trimmed);
    if (fm) {
      const marker = fm[1][0];
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      // else: a mismatched marker inside an open fence is literal content, not a close.
      continue;
    }
    if (fence) continue;
    const item = /^[-*] (.*)$/.exec(trimmed);
    if (!item) continue;
    const edge = parseEdgeLine(item[1]);
    if (edge) edges.push(edge);
  }
  return edges;
}

// Undo assembleBody's escCell pipe-escaping (`\|` → `|`). escCell also collapses a
// def's internal newlines to spaces before emit, so that fold is not (and cannot be)
// reversed here — a documented one-way loss, not a bug.
const unescCell = (s: string): string => s.replace(/\\\|/g, "|").trim();

// Split a `| a | b |` table row into trimmed, unescaped cells. Outer pipes are
// dropped; the split runs on unescaped `|` only (negative lookbehind), so a def
// carrying a real `|` (escCell-escaped) never mis-splits into a phantom column.
function glossaryRowCells(line: string): string[] | null {
  const t = line.trim();
  if (t.length < 2 || !t.startsWith("|") || !t.endsWith("|")) return null;
  return t
    .slice(1, -1)
    .split(/(?<!\\)\|/)
    .map(unescCell);
}

// A GFM table delimiter row (`| ---- | ---------- |`): every cell is bare dashes,
// optionally colon-anchored. Shared by the header/delimiter skip below.
const isDelimiterRow = (cells: string[]): boolean => cells.every((c) => /^:?-+:?$/.test(c));

// Parse an emitted note's `## Glossary` table AND `## Relations` block into
// GlossEntry[] — the REBUILD inverse of assembleBody's Glossary+Relations
// rendering. Each row becomes one entry (term, def unescaped, source: [] — not
// recoverable from an emitted note, D13); each parsed edge attaches to the entry
// whose slug matches its `from`. A single-atom edge (`from === null`) attaches to
// the sole entry when the table has exactly one row; over a multi-row table it has
// no unambiguous owner and is dropped (lossy, matches parseRelationsBlock's tolerance).
export function parseConceptGraph(md: string): GlossEntry[] {
  const entries: GlossEntry[] = [];
  for (const line of extractSection(md, "glossary").split("\n")) {
    const cells = glossaryRowCells(line);
    if (!cells || cells.length < 2) continue;
    if (cells[0] === "Term" && cells[1] === "Definition") continue; // header row
    if (isDelimiterRow(cells)) continue;
    entries.push({ term: cells[0], def: cells[1], relations: [], source: [] });
  }
  for (const edge of parseRelationsBlock(md)) {
    const rel: Relation = { rel: edge.rel, to: edge.to, predicate: edge.predicate };
    if (edge.from !== null) {
      // Slug BOTH sides before comparing (Finding 3): emitted notes pre-slug the
      // from-label so a raw comparison happens to match, but Log 10 makes human
      // editing of the Relations line the expected path, and a hand-typed unslugged
      // label ("Target Distance" over a glossary row "Target Distance") must still
      // resolve to its entry instead of silently detaching the whole relation.
      const fromSlug = slugSegment(edge.from);
      entries.find((e) => slugSegment(e.term) === fromSlug)?.relations.push(rel);
    } else if (entries.length === 1) {
      entries[0].relations.push(rel);
    }
    // else: single-atom edge over a 0- or multi-row table has no unambiguous owner — drop.
  }
  return entries;
}

export function detectLang(text: string): "en" | "ru" {
  const letters = text.match(/[a-zA-Zа-яА-ЯёЁ]/g) ?? [];
  if (letters.length === 0) return "en";
  const cyr = letters.filter((c) => /[а-яА-ЯёЁ]/.test(c)).length;
  return cyr / letters.length > 0.3 ? "ru" : "en";
}

// distill generates new natural-language text (abstractive), so every prompt must
// pin the output language to the note's own — else a Russian note distills to English.
const langName = (lang: "en" | "ru"): string => (lang === "ru" ? "Russian" : "English");
export const langRule = (lang: "en" | "ru"): string =>
  `Write every natural-language value (description, thesis, term, def, relations, step, prose) in ${langName(lang)} — match the note's own language. Keep code, paths, identifiers, and [[wikilink]] targets verbatim.`;
