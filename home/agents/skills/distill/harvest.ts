// harvest — the payload/link/prose-list harvest spine of the distill pipeline: the
// deterministic loss surface that makes a dropped span LOUD. Three cooperating lanes:
// the vault-edge harvesters ([[wikilink]] / [text](path)), the seven structural-payload
// harvesters (fenced code, blockquotes, table rows, images, math, citations, statistics)
// plus the shared structural detection (collectStructural / structuralSpans) that this
// file's harvesters and route.ts's density router both read, and the prose-list-item
// inventory (harvestProseListItems, the prose-judge answer key). Pure string/data, no
// I/O, no LLM. Imports only leaf utilities from text.ts (slug/url/fence helpers) and
// mdstruct.ts, so it stays a tier above text.ts and never cycles back into it.
import {
  parseDoc,
  sliceBytes,
  walkNodes,
  type ParsedDoc,
  type Span,
  type MdNode,
  type MdInline,
} from "./mdstruct.ts";
import {
  ASSET_RE,
  decodeTarget,
  fenceScan,
  type FenceState,
  isExternalUrl,
  MASK_RE,
  slugSegment,
  stripFences,
  type VaultEdge,
  wikilinkTarget,
} from "./text.ts";

// The Markdown inline-link grammar `[text](url "title")`, shared by harvestExternalLinks
// and harvestInternalLinks so the two complementary lanes (split by isExternalUrl) can
// never drift. Excludes images (`!` lookbehind) and wikilinks (`]` lookbehind). The url
// group `[^)\s]+` forbids a literal space, so a spaced path must be %20-encoded. Safe to
// share at module scope: String.prototype.matchAll clones the regex, so lastIndex never
// carries between calls.
const MD_LINK_RE = /(?<![!\]])\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

// Harvest every [[wikilink]] (and ![[embed]]) in `text` as {markup, slug, target}:
// `markup` is the verbatim span, `slug` its target slugged for byte-stable comparison,
// `target` the raw alias-stripped endpoint (the collision discriminator wikilinkResidue
// keys on). An alias `[[t|a]]` harvests target `t`; the slug matches the projection's
// pre-slugged file endpoints and a retained block's verbatim link alike, since
// slugSegment is idempotent. ITEM B: an asset embed (`![[diagram.png]]`, `![[doc.pdf#page=2]]`)
// is NOT an edge — it renders inline, so it is skipped here lest it surface as a phantom
// dropped-wikilink; a bare `[[x.png]]` (no `!` embed) and a note transclusion `![[some-note]]`
// or `![[some-note#heading]]` (no asset ext) stay real edges. Part of harvestVaultEdges, the source-of-truth for a note's
// cross-note edges: residue.ts::wikilinkResidue diffs source against output over these
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
    const target = wikilinkTarget(m[1]);
    if (m[0].startsWith("!") && ASSET_RE.test(target)) continue;
    const slug = slugSegment(target);
    if (slug) out.push({ markup: m[0], slug, target });
  }
  return out;
}

// Harvest every EXTERNAL [text](url) Markdown link — the citation/source lane, distinct
// from vault edges. Keeps ONLY links whose url is external (isExternalUrl):
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
// cross-note edge, the markdown-syntax sibling of a [[wikilink]]. Mirrors
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
    // strip a leading `./` then the `#fragment` + decode (decodeTarget) before slugging
    const path = decodeTarget(raw.replace(/^\.\//, ""));
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

// ---- one structural detection, shared by every consumer below ----
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

// The categorized structural payload of a parsed doc, harvested ONCE by collectStructural.
// structuralSpans composes the flat byte-span union from it for route.ts's density router
// (payloadMask blanks these bytes as the router's structural signal); each of the four
// structural harvesters below reads the category it owns and applies its own
// key-normalization for the residue inventory. Detecting structure exactly once and sharing
// the result this way means the router and the residue inventory can never disagree about
// what counts as structural. Blockquotes are top-level only (nested `> >` runs merge,
// matching the regex `>`-run this replaced); every other lane descends fully, so a fence or
// table nested inside a quote or list still counts.
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

// collectStructural walks a parsed document once and buckets its structural nodes (fences,
// tables, table rows, blockquotes, images, pseudo-table rows) into a StructuralParts record,
// memoized per ParsedDoc via structuralCache so repeated calls for the same document never
// re-walk it.
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
      const t = wikilinkTarget(il.page);
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
// a retained block (held verbatim as a `## Payload` unit, statement = b.text) covers its
// source twin regardless of info-string. Internal whitespace is KEPT: code indentation is
// load-bearing.
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
// A `>`-prefixed blockquote line, capturing its inner text after the marker. Used by
// harvestBlockquotes to recover a quote's inner prose from the mdstruct blockQuote span
// collectStructural already found — the span itself, not this regex, is what route.ts's
// payloadMask blanks for the router signal.
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
// into ≥2 non-empty cells, and is not the `:?-+:?` delimiter row. One detection feeding two
// consumers: collectStructural calls this to find pseudo-table rows for route.ts's density
// router (via structuralSpans), and harvestTableRows calls it again to inventory the same
// rows' payload for the residue gate.
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
      const u = decodeTarget(il.url.trim());
      const key = slugSegment(u);
      if (key) out.push({ markup: oneLine(il.span ? sliceBytes(buf, il.span) : il.url), key });
    } else if (il.type === "wikilink" && il.page != null) {
      // collectStructural already filtered these to embed + ASSET_RE; just slug the target.
      const t = wikilinkTarget(il.page);
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
// harvestMath (payload inventory here) and route.ts's payloadMask (router signal) — the
// same pattern list drives both, so they can never disagree on what counts as display math.
export const DISPLAY_MATH_PATTERNS = [
  /\$\$([\s\S]+?)\$\$/g,
  /\\\[([\s\S]+?)\\\]/g,
  /\\\(([\s\S]+?)\\\)/g,
];
// Math/formulas harvester: see the comment above MATH_OP for the inline-vs-display admission
// rule and the key format.
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
// Substantive numeric statistics harvester: see the comment above NUM_RE for the substance
// gate and bare-year exclusion; scrubForNumbers (above) removes non-statistic digit sources
// first.
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

// ---- prose-list-item inventory (the prose-judge tier) ----
// The payload spine above catches LITERAL/STRUCTURAL loss but is blind to a dropped pure-
// prose list-item — a `Признаки нарушения` bullet, a `Шаблоны` pattern, an F1–F7 enumerated
// claim — and so are the fidelity/workflow gates (they only judge the defs and steps the
// extractor lifted). This harvester does NOT decide coverage; it only enumerates the must-
// cover CLASS (explicit list-items under a depth≥2 heading) as an answer key for the glm
// matcher (gates.ts::runProseGate). A list-item is an ATOMIC enumerated claim, not
// restatement-collapsible prose, which is why per-item judging is false-flag-free where a
// coarse prose-span judge is not — worked examples, thesis spans, and heading-less essays
// stay deferred. Four deterministic exclusions narrow the inventory to must-cover items;
// none is a meaning judgment — the layer enumerates and excludes, it never declares survival.
export type ProseUnit = { id: string; heading: string; depth: number; span: string };

// Lowercase, strip markdown punctuation, collapse whitespace — a containment-comparable
// form shared by EXCLUSION-3 (extractor-claimed) here and the anchor relevance re-check in
// the matcher (residue.ts::anchored).
export const normalizeForContainment = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[`*_>#|[\]()!~-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// ATX heading grammar for the prose-list scan (marker + title), depth 2–6 — the intro/lead
// before the first `##` is EXCL-1 thesis-owned and never inventoried.
const HEAD = /^(#{2,6})\s+(.*)$/;
// markdown bullets (- * +), numbered (1. / 1)), and the A–F / Cyrillic enum markers the
// vault's scenario / moat / worked-example lists use (F1. A) Сценарий-Б.). The uppercase
// A–F restriction keeps a prose abbreviation ("e.g.") from registering as a list marker.
const ITEM = /^\s*(?:[-*+]|\d+[.)]|[A-FА-Я]\d*[.)])\s+(.*\S)\s*$/;

// EXCL-2 payload/spine-owned: a bullet that is wholly a wikilink / image / table row /
// citation / inline-code / number is already covered by the seven payload lanes — strip
// those and check for residual prose. Returns false when nothing prose-like remains.
const hasResidualProse = (body: string): boolean => {
  const probe = stripFences(body)
    .replace(MASK_RE, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)|!\[\[[^\]]+\]\]/g, " ")
    .replace(/^\s*\|.*\|?\s*$/g, " ");
  return /\S/.test(probe);
};

// EXCL-4 too thin to carry a claim (heading echo, scaffold): the normalized body is under
// 12 chars once markdown punctuation is stripped.
const tooThinToClaim = (norm: string): boolean => norm.length < 12;

// EXCL-3 extractor-claimed: the item was folded into a def or step the extractor lifted, so
// fidelityGate/workflowGate already judge it. Information-grounded (the extractor's own source
// attribution), a best-effort REDUCER — a non-contiguously cited item may slip to the matcher,
// costing a token, never a false residue. `claimNorm` is the containment-normalized claim set.
const isExtractorClaimed = (norm: string, claimNorm: string[]): boolean =>
  claimNorm.some((c) => c.includes(norm));

// harvestProseListItems enumerates the must-cover prose list-item inventory for `text`
// (explicit list-items under a depth≥2 heading, minus the four exclusions above), excluding
// any item already covered by `claimed` — the extractor's own claimed statements, matched by
// containment after normalizeForContainment.
export function harvestProseListItems(text: string, claimed: string[]): ProseUnit[] {
  const claimNorm = claimed.map(normalizeForContainment).filter((c) => c.length > 0);
  const lines = text.split("\n");
  const units: ProseUnit[] = [];
  let fence: FenceState = null;
  let curHeading = "";
  let curDepth = 0;
  let sawHeading = false;
  let n = 0;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const scan = fenceScan(ln, fence);
    fence = scan.fence;
    if (scan.isMarker) continue;
    if (fence) continue;
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
    if (!hasResidualProse(body)) continue; // EXCL-2 payload/spine-owned
    const norm = normalizeForContainment(body);
    if (tooThinToClaim(norm)) continue; // EXCL-4 too thin to carry a claim
    if (isExtractorClaimed(norm, claimNorm)) continue; // EXCL-3 extractor-claimed
    units.push({
      id: `${slugSegment(curHeading) || "prose"}-${n++}`,
      heading: oneLine(curHeading, 60),
      depth: curDepth,
      span: oneLine(body, 300),
    });
  }
  return units;
}
