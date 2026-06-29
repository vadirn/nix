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
  // note-level edges (D38): hostless cross-note relations whose source endpoint is
  // the note ITSELF (not a glossary term). Emitted in `## Relations` with the note's
  // own [[self-slug]] as the from-label. A separate channel from glossary[].relations
  // so it needs no glossary-term host and no synthetic carrier entry.
  noteRelations: Relation[];
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
    const target = m[1].split("|")[0].trim();
    // asset gate runs on a fragment-STRIPPED target (ASSET_RE is `$`-anchored), so a
    // page/section embed like `![[doc.pdf#page=2]]` is still caught — aligning this gate
    // with harvestInternalLinks. slug/target keep the fragment, so the cross-component
    // join key (harvest ↔ emitRelationsBlock ↔ coverage) is byte-for-byte unchanged.
    if (m[0].startsWith("!") && ASSET_RE.test(target.replace(/#.*$/, ""))) continue;
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
export function harvestInternalLinks(text: string): VaultEdge[] {
  const out: VaultEdge[] = [];
  for (const m of text.matchAll(MD_LINK_RE)) {
    const raw = m[2].trim();
    if (!raw || isExternalUrl(raw)) continue;
    let path = raw.replace(/^\.\//, "").replace(/#.*$/, "");
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

// Note-level edges (D37): a hostless `[[self-slug]] → [[file-slug]]` edge is admissible
// ONLY with a quotable directional predicate — that quoted source phrase is the audit
// trail that keeps the edge D36-compliant (no fabricated `rel`). The gate is load-bearing
// (D37a), so enforce it in CODE, not by model-trust: normalize each edge, then DROP any
// whose predicate is null/empty. A dropped link is not lost — it falls through to
// `wikilinkResidue` as loud residue for the curator, never ships as an untraceable edge.
export function normalizeNoteRelations(raw: unknown): Relation[] {
  return (Array.isArray(raw) ? raw : [])
    .map((r) => normalizeRelation(r))
    .filter((r): r is Relation => r !== null && r.predicate !== null);
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
