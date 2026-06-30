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
export function harvestBlockquotes(text: string): PayloadSpan[] {
  const out: PayloadSpan[] = [];
  let raw: string[] = [];
  let inner: string[] = [];
  const flush = () => {
    if (inner.length) {
      const key = inner.join(" ").replace(/\s+/g, " ").trim().toLowerCase();
      if (key) out.push({ markup: oneLine(inner.join(" ")), key });
    }
    raw = [];
    inner = [];
  };
  for (const line of text.split("\n")) {
    const m = /^\s*>+\s?(.*)$/.exec(line);
    if (m) {
      raw.push(line);
      inner.push(m[1]);
    } else flush();
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
export function harvestTableRows(text: string): PayloadSpan[] {
  const out: PayloadSpan[] = [];
  const rawLines = text.split("\n");
  const mLines = stripFences(text).replace(MASK_RE, " ").split("\n");
  for (let i = 0; i < mLines.length; i++) {
    const line = mLines[i];
    if (!line.includes("|")) continue;
    const cells = line
      .trim()
      .replace(/^\||\|$/g, "")
      .split(/(?<!\\)\|/)
      .map((c) => c.trim());
    if (cells.length < 2 || cells.every((c) => c === "")) continue;
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue; // delimiter row
    out.push({
      markup: oneLine((rawLines[i] ?? line).trim()),
      key: cells.map((c) => c.toLowerCase()).join("␟"),
    });
  }
  return out;
}

// Images + Obsidian asset embeds — the inline-render lane harvestWikilinks SKIPS, so today
// a dropped image falls through BOTH gates. Markdown `![alt](url)` keyed by url slug; asset
// embed `![[x.png]]` (ASSET_RE) keyed by target slug. Both fragment-stripped + decoded, so
// an embed surviving in a retained block covers its source twin.
export function harvestImages(text: string): PayloadSpan[] {
  const out: PayloadSpan[] = [];
  for (const m of text.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    let u = normalizeEdgeTarget(m[1].trim());
    try {
      u = decodeURIComponent(u);
    } catch {
      // malformed %-sequence: keep raw (still a comparable key)
    }
    const key = slugSegment(u);
    if (key) out.push({ markup: oneLine(m[0]), key });
  }
  for (const m of text.matchAll(/!\[\[([^\]]+)\]\]/g)) {
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
export function harvestMath(text: string): PayloadSpan[] {
  const out: PayloadSpan[] = [];
  const src = stripFences(text);
  const push = (markup: string, inner: string) => {
    const key = inner.replace(/\s+/g, "").toLowerCase();
    if (key) out.push({ markup: oneLine(markup), key });
  };
  for (const m of src.matchAll(/\$\$([\s\S]+?)\$\$/g)) push(m[0], m[1]);
  for (const m of src.matchAll(/\\\[([\s\S]+?)\\\]/g)) push(m[0], m[1]);
  for (const m of src.matchAll(/\\\(([\s\S]+?)\\\)/g)) push(m[0], m[1]);
  const noDisplay = src.replace(/\$\$[\s\S]+?\$\$/g, " ");
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
