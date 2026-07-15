// text — the leaf utilities of the distill pipeline: fence-aware segmentation, the latching
// fence scanner, slugging (the vault-query slug.rs mirror), url/edge-target normalization,
// language detection + the prompt language rule, the structural `NormalizedEdge` relation
// shape (see graph.ts for the canonical typed graph), and the shared type/const declarations
// the harvest/route/rel-parse tiers import. Pure string/data utilities with no I/O; its only
// non-type dependency is kernel/typography.ts (normalizeTypography, factored there and
// re-exported here) — itself a leaf, so this stays leaf-tier. The heavier concerns that once
// lived here moved out to cohesive modules a tier above: the payload/link/prose-list harvest
// spine (harvest.ts), the per-section density router (route.ts), and the `## Relations` REBUILD
// parser (rel-parse.ts). cards/ imports those symbols (sections, parseRelationsBlock) from
// their real homes directly, so text.ts stays a pure leaf with no upward edge.
import { normalizeTypography } from "@/core/typography.ts";

// Relations registry — TS-native copy of the open relation vocabulary (structural
// channel only). Mirror of vault-query/src/commands/lint/rel-registry.json, the
// test-only canonical ground truth; parity is pinned by distill.test.ts (which reads
// that JSON and asserts equality with this const). Read at runtime from here, never
// from the JSON, so emit stays file-I/O-free. Three tokens the extractor already emits
// (subsumes / precondition-for / contrast-to) plus four it is starting to emit
// (depends-on / part-of / instance-of / refines). supersedes and contradicts are
// excluded by channel (frontmatter- and merge-gated respectively).
//
// OPEN registry: a known/suggested vocabulary, NOT an enforced closed set — a
// closed `type::` enum could not hold the Chesterton's Fence deontic relation. locateGraph
// and projectMarkdown accept any `rel` token; only cards/cards.ts reads this list, to flag
// an off-registry rel for human review (`offRegistry`), never to drop or reject it.
export const REL_REGISTRY: readonly string[] = [
  "subsumes",
  "precondition-for",
  "contrast-to",
  "depends-on",
  "part-of",
  "instance-of",
  "refines",
];

// One segmented chunk of a note: `id` is its stable `B<n>` label (assigned by segment() in
// document order), `text` its raw source lines rejoined with `\n`.
export type Block = { id: string; text: string };
// One normalized STRUCTURAL edge from the live extractor's relation channel:
// `rel` an open hyphenated token, `to` an endpoint (a bare local term-slug or a
// [[file-slug]] wikilink), `predicate` an optional one-clause gloss (null when none).
// The from-label is NOT a field — the caller supplies it (parseExtractGraph owns the
// concept's headword). `quote` is the VERBATIM source slice the edge was distilled from
// (byte-exact, never typography-normalized) — the span-locate anchor the canonical
// projection resolves; optional. Produced by normalizeRelation, folded into a PreEdge
// by parseExtractGraph (prompts.ts).
export type NormalizedEdge = { rel: string; to: string; predicate: string | null; quote?: string };
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

// ---- ONE latching fence scanner, six call sites ----
// Track whether a line-by-line scan sits inside a ``` / ~~~ code fence. `fence` is the OPEN
// marker char (backtick or tilde) or null outside a fence. A run of 3+ backticks or tildes at
// line start opens; a run of 3+ of the SAME char closes. An opposite-marker run inside an open
// fence is literal content, not a close — latching the opener is what stops segment() (and its
// five siblings) from mis-toggling parity on a nested opposite fence and swallowing the tail.
// Returns the next state and whether THIS line was a real fence marker (opener or closer);
// callers that emit or skip marker lines branch on `isMarker`.
export type FenceState = string | null;
export function fenceScan(
  line: string,
  fence: FenceState,
): { fence: FenceState; isMarker: boolean } {
  const m = /^\s*(`{3,}|~{3,})/.exec(line);
  if (!m) return { fence, isMarker: false };
  const marker = m[1]![0]!;
  if (fence === null) return { fence: marker, isMarker: true };
  if (fence === marker) return { fence: null, isMarker: true };
  return { fence, isMarker: false }; // opposite marker inside a fence: literal content
}

// Segment text into Blocks split on blank lines, keeping a ``` / ~~~ fenced code region whole
// (via fenceScan) even across an internal blank line. Blocks are numbered `B1`, `B2`, … in
// document order.
export function segment(text: string): Block[] {
  const lines = text.split("\n");
  const out: string[][] = [];
  let cur: string[] = [];
  let fence: FenceState = null;
  const flush = () => {
    if (cur.length) {
      out.push(cur);
      cur = [];
    }
  };
  for (const line of lines) {
    const scan = fenceScan(line, fence);
    fence = scan.fence;
    if (scan.isMarker) {
      cur.push(line);
      continue;
    }
    if (fence) {
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

// Blank every fenced region (``` / ~~~, 3+ markers) line-for-line, preserving line count
// so a caller can align scrubbed lines with raw ones. A `|`, `$`, or digit inside a code
// block is code, never a table cell / formula / statistic, so the number/table/math/citation
// lanes scrub fences first. A leaf util shared by harvest.ts (the payload lanes) and
// rel-parse.ts (extractSection's fence-masked heading scan).
export function stripFences(text: string): string {
  const out: string[] = [];
  let fence: FenceState = null;
  for (const line of text.split("\n")) {
    const scan = fenceScan(line, fence);
    fence = scan.fence;
    if (scan.isMarker) {
      out.push("");
      continue;
    }
    out.push(fence ? "" : line);
  }
  return out.join("\n");
}

// Render Blocks back to their `[id] text` display form, one blank line between blocks — the
// inverse of segment()'s grouping, used to show a segmented note to a human or a prompt.
export function render(blocks: Block[]): string {
  return blocks.map((b) => `[${b.id}] ${b.text}`).join("\n\n");
}

// Count whitespace-separated words in a string; an empty or whitespace-only string counts as 0.
export function wordCount(s: string): number {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
}

// Render glossary entries as a markdown bullet list, one `- term: def` line per entry.
export const glossList = (entries: { term: string; def: string }[]): string =>
  entries.map((e) => `- ${e.term}: ${e.def}`).join("\n");

// hasWikilink reports whether text contains a `[[wikilink]]` — the regex also matches a
// `![[...]]` embed, since the embed syntax wraps a wikilink. Deterministic (a plain regex
// test), so a caller relying on it to decide whether a block must be retained verbatim
// (rather than re-authored) can never miss a wikilink it should have protected.
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

// Strip a trailing `#fragment` (a section/block anchor like `note#heading` or
// `note.md#page=2`) from an edge target BEFORE it is slugged, so an anchored link and
// its bare form harvest to the SAME slug — `[[note#heading]]` and `[x](note.md#heading)`
// both yield `note`, not `note-heading`. Runs OUTSIDE slugSegment (which must keep
// mirroring vault-query slug.rs::segment); the fragment strip is a harvest concern, not
// a slug-grammar one. Shared by both harvest lanes so the two never drift. Without this,
// a fragment-bearing source edge slugged WITH its anchor and read as dropped against an
// output that links the bare note — a wikilinkResidue false positive.
function normalizeEdgeTarget(raw: string): string {
  return raw.replace(/#.*$/, "");
}

// The wikilink-endpoint idiom shared by every `[[target|alias]]` harvest site: strip
// the `|alias`, trim, then normalizeEdgeTarget. Centralized so the three sites (bare
// wikilink harvest, inline-link page, embed page) can never drift on ordering.
export function wikilinkTarget(raw: string): string {
  return normalizeEdgeTarget(raw.split("|")[0].trim());
}

// The fragment-strip + best-effort percent-decode idiom shared by every URL/path harvest
// site: normalizeEdgeTarget, then decodeURIComponent, tolerating a malformed %-sequence
// by keeping the fragment-stripped-but-undecoded raw (still a comparable key). Centralized
// so harvestInternalLinks (path) and harvestImages (image url) can never drift on the catch.
export function decodeTarget(raw: string): string {
  const stripped = normalizeEdgeTarget(raw);
  try {
    return decodeURIComponent(stripped);
  } catch {
    return stripped;
  }
}

// hasOperational reports whether text carries operational tokens that must survive verbatim —
// code, CLI flags, file paths. Used by the wikilink clamp to choose retain over distill for
// a block.
export const hasOperational = (text: string): boolean =>
  /```|`[^`\n]+`|\s--?[a-z]/i.test(text) || /(^|\s)(\/|~\/|\.\/)\S+/.test(text);

// Reference spans the revise passes must keep verbatim and that never need
// rewording: wikilinks, embeds (![[...]]), and inline code. They are masked to
// opaque ⟦N⟧ tokens for the duration of revise, then restored (see revise()).
export const MASK_RE = /!?\[\[[^\]]+\]\]|`[^`\n]+`/g;

// Deterministic typographic normalization — owned by kernel/typography.ts (the
// core), re-exported here so text.ts's existing importers (pure.test.ts:35 and
// every internal user below) keep working unchanged.
export { normalizeTypography } from "@/core/typography.ts";

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
export const relText = (r: { rel: string; to: string; predicate: string | null }): string =>
  `${r.rel} :: ${r.to}${r.predicate ? ` (${r.predicate})` : ""}`;

// Coerce one extracted relation into a typed edge. LOSSY: keep every
// well-formed edge — drop ONLY when `rel` or `to` is missing. An unknown rel or an
// unresolved endpoint is a REBUILD lint finding, never a BUILD drop. Relations skip
// revise(), so typography is normalized here. The rel is lowercased and hyphenated
// (residual space-forms like "precondition for" → "precondition-for") so the open
// token matches the registry's shape; predicate is null when empty.
export function normalizeRelation(r: unknown): NormalizedEdge | null {
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

// Detect whether text is predominantly Russian or English by the Cyrillic share of its
// letters (ASCII + Cyrillic only): over 30% Cyrillic letters classifies as "ru", else "en";
// a text with no letters at all defaults to "en".
export function detectLang(text: string): "en" | "ru" {
  const letters = text.match(/[a-zA-Zа-яА-ЯёЁ]/g) ?? [];
  if (letters.length === 0) return "en";
  const cyr = letters.filter((c) => /[а-яА-ЯёЁ]/.test(c)).length;
  return cyr / letters.length > 0.3 ? "ru" : "en";
}

const langName = (lang: "en" | "ru"): string => (lang === "ru" ? "Russian" : "English");
// langRule renders the prompt instruction pinning distill's generated natural-language text
// to the note's own language (English or Russian) — necessary because distill generates new
// text abstractively, so an unconstrained prompt could distill a Russian note into English.
export const langRule = (lang: "en" | "ru"): string =>
  `Write every natural-language value (description, thesis, term, def, relations, step, prose) in ${langName(lang)} — match the note's own language. Keep code, paths, identifiers, and [[wikilink]] targets verbatim.`;
