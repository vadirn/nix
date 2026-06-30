// text — segmentation, typography, slugging, relation/IR types, and the language
// helpers. The leaf module of the distill pipeline: pure string/data utilities
// with no I/O and no dependency on any other distill module.

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
// the entry's own `term`, supplied by the assembler (emitRelationsBlock).
export type Relation = { rel: string; to: string; predicate: string | null };
export type GlossEntry = { term: string; def: string; relations: Relation[]; source: string[] };
// a workflow step is an ACTIONABLE directive the note prescribes (a practice, a
// procedure step) — the procedural sink the glossary (concepts) cannot hold. The
// step carries a source-stated reason ("do X because Y") when the source gives
// one; the gate tolerates a dropped reason but forbids an invented one.
export type WorkStep = { step: string; source: string[] };
export type IR = {
  description: string;
  thesis: string;
  glossary: GlossEntry[];
  workflow: WorkStep[];
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

// Verbatim fenced code/output blocks. key = the inner body, each line right-trimmed,
// leading/trailing blank lines dropped — the language tag and fence width are excluded, so
// a retained block (assembleBody pushes b.text verbatim) covers its source twin regardless
// of info-string. Internal whitespace is KEPT: code indentation is load-bearing.
export function harvestFences(text: string): PayloadSpan[] {
  const out: PayloadSpan[] = [];
  const lines = text.split("\n");
  let open: string | null = null;
  let body: string[] = [];
  let head = "";
  for (const line of lines) {
    const m = /^[ \t]*(`{3,}|~{3,})/.exec(line);
    if (!open && m) {
      open = m[1][0];
      body = [];
      head = line.trim();
      continue;
    }
    if (open && m && line.trimStart().startsWith(open.repeat(3))) {
      const key = body
        .map((l) => l.replace(/\s+$/, ""))
        .join("\n")
        .replace(/^\n+|\n+$/g, "");
      if (key) out.push({ markup: oneLine(head + " " + (body[0] ?? "")), key });
      open = null;
      continue;
    }
    if (open) body.push(line);
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

export function harvestBlockquotes(text: string): PayloadSpan[] {
  const out: PayloadSpan[] = [];
  let inner: string[] = [];
  const flush = () => {
    if (inner.length) {
      const key = inner.join(" ").replace(/\s+/g, " ").trim().toLowerCase();
      if (key) out.push({ markup: oneLine(inner.join(" ")), key });
    }
    inner = [];
  };
  for (const line of text.split("\n")) {
    const m = BLOCKQUOTE_LINE.exec(line);
    if (m) inner.push(m[1]);
    else flush();
  }
  flush();
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

export function harvestTableRows(text: string): PayloadSpan[] {
  const out: PayloadSpan[] = [];
  const rawLines = text.split("\n");
  const mLines = stripFences(text).replace(MASK_RE, " ").split("\n");
  for (let i = 0; i < mLines.length; i++) {
    if (!isTableDataRow(mLines[i])) continue;
    out.push({
      markup: oneLine((rawLines[i] ?? mLines[i]).trim()),
      key: tableCells(mLines[i])
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
// Markdown image `![alt](url)` (url captured) and Obsidian embed `![[target]]` (target
// captured). Shared by harvestImages (payload inventory, asset-filtered) and payloadMask
// (router signal) — one detection, two uses (D2).
export const MD_IMAGE_RE = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
export const EMBED_RE = /!\[\[([^\]]+)\]\]/g;
export function harvestImages(text: string): PayloadSpan[] {
  const out: PayloadSpan[] = [];
  for (const m of text.matchAll(MD_IMAGE_RE)) {
    let u = normalizeEdgeTarget(m[1].trim());
    try {
      u = decodeURIComponent(u);
    } catch {
      // malformed %-sequence: keep raw (still a comparable key)
    }
    const key = slugSegment(u);
    if (key) out.push({ markup: oneLine(m[0]), key });
  }
  for (const m of text.matchAll(EMBED_RE)) {
    const t = normalizeEdgeTarget(m[1].split("|")[0].trim());
    if (ASSET_RE.test(t)) {
      const key = slugSegment(t);
      if (key) out.push({ markup: oneLine(m[0]), key });
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

// Split on every ATX heading (depth 1–6). The lead before the first heading is the intro
// section (heading "", depth 0); it is dropped when blank. Each section's text includes its
// own heading line; `heading` holds the title text (markers stripped), `depth` the level.
const ATX_HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
export function sections(text: string): Section[] {
  const out: Section[] = [];
  let cur: Section = { heading: "", depth: 0, text: "" }; // lead / intro
  const push = () => {
    if (cur.depth > 0 || /\S/.test(cur.text)) out.push(cur);
  };
  for (const line of text.split("\n")) {
    const m = ATX_HEADING.exec(line);
    if (m) {
      push();
      cur = { heading: m[2].trim(), depth: m[1].length, text: line };
    } else {
      cur.text = cur.text === "" ? line : cur.text + "\n" + line;
    }
  }
  push();
  return out;
}

// Blank the structural payload spans (fenced code, table rows, blockquotes, display math,
// image lines), preserving line count so the masked copy aligns with the source. Reuses the
// harvest detection — the router's signal is the same primitive as the residue gate's.
export function payloadMask(text: string): string {
  const fenceMasked = stripFences(text); // fence lane: owns fenced code/output
  const rowProbe = fenceMasked.replace(MASK_RE, " ").split("\n"); // table-row detection copy
  let masked = fenceMasked
    .split("\n")
    .map((line, i) => {
      if (isTableDataRow(rowProbe[i])) return ""; // table-row lane
      if (BLOCKQUOTE_LINE.test(line)) return ""; // blockquote lane
      return line;
    })
    .join("\n");
  // Display-math + image lanes blank in place, replacing each non-newline char with a space
  // so multi-line spans keep their line count. Markdown images blank unconditionally; embeds
  // only when the target is an asset (the same ASSET_RE filter harvestImages applies).
  const blankKeepingLines = (s: string, re: RegExp) =>
    s.replace(re, (m) => m.replace(/[^\n]/g, " "));
  for (const re of DISPLAY_MATH_PATTERNS) masked = blankKeepingLines(masked, re);
  masked = blankKeepingLines(masked, MD_IMAGE_RE);
  masked = masked.replace(EMBED_RE, (m, inner) =>
    ASSET_RE.test(normalizeEdgeTarget(String(inner).split("|")[0].trim()))
      ? m.replace(/[^\n]/g, " ")
      : m,
  );
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
export type Unit = { heading: string; depth: number; text: string; route: Route };

// Partition a note for the per-section build: lift the leading H1 as the note title
// (emitted first, independent of any section's route — fix #1), then route each remaining
// top-level section. Sections deeper than the top level fold into their parent unit so a
// payload subsection is never torn from its prose parent (fix #2). Pure; no I/O, no model.
export function partition(
  text: string,
  tau: number = DEFAULT_TAU,
): { title: string; units: Unit[] } {
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
  const units: Unit[] = grouped.map((u) => ({ ...u, route: routeSection(u.text, tau) }));
  return { title, units };
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

// Deterministic typographic normalization. The revise model substitutes typeset
// glyphs (curly quotes, a non-breaking hyphen) regardless of prompt instruction;
// this maps the finite set back. Em dashes (—) are kept as clause breaks (the
// source notes use them) but normalized to spaced form ( — ), since the model
// emits them tight (model—assuming) about half the time. It touches only
// substitutes — it leaves Cyrillic and source guillemets alone, safe for RU.
export function normalizeTypography(s: string): string {
  return s
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–]/g, "-") // hyphen/nbhyphen/figure/en (ranges) → bare - (em dash — is kept)
    .replace(/[ \t]*[—―][ \t]*/g, " — ") // em dash / bar → spaced em dash; never eats a newline
    .replace(/…/g, "...")
    .replace(/ /g, " "); // nbsp → space
}

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
  const o = r as { rel?: unknown; to?: unknown; predicate?: unknown };
  const rel = normalizeTypography(String(o.rel ?? ""))
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
  const to = normalizeTypography(String(o.to ?? "")).trim();
  if (!rel || !to) return null;
  const pred = o.predicate == null ? "" : normalizeTypography(String(o.predicate)).trim();
  return { rel, to, predicate: pred || null };
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
