// mdstruct — the CLI-wrapper seam: distill's four structural payload harvesters (fences,
// blockquotes, table rows, image embeds) locate their spans through this module instead of
// line-scanning regex. Only the LOCATOR moved here; the key-normalization stays in text.ts.
//
// Fail-loud: a missing or unparseable binary throws `mdstruct unavailable` rather than
// degrading to regex. Residue is a correctness gate (it tells the user real payload was
// dropped), so a silent fallback would reintroduce the very bugs this fixes.
import { execFileSync, type StdioOptions } from "node:child_process";

// MDSTRUCT_BIN overrides the bare-name PATH resolution so tests can point at a freshly-built
// binary (with newer flags); production leaves it unset and resolves `mdstruct` on PATH.
// Read once at module load — env is fixed for the process lifetime, so both call sites
// (parseDoc, checkRegion) share this instead of re-reading process.env per call.
const MDSTRUCT_BIN = process.env.MDSTRUCT_BIN ?? "mdstruct";
// Both spawns can return large NDJSON payloads (a big note's full region/diagnostic set);
// shared so the two child_process limits never drift apart.
const MDSTRUCT_MAX_BUFFER = 1 << 28;

// A `[startByte, endByte)` pair into the source buffer. Slices run on Buffer bytes, never JS
// UTF-16 string indices — Cyrillic round-trips byte-exact only on a Buffer.
export type Span = [number, number];

// A block node in `nodes[]`. `bodySpan` is a fence's inner body (info-string + fences
// excluded); `span` is the whole node. `children` is walked recursively (comrak nests blocks
// under lists/quotes).
export interface MdNode {
  type: string;
  fenced?: boolean;
  bodySpan?: Span;
  span?: Span;
  startLine?: number;
  endLine?: number;
  children?: MdNode[];
}

// An inline in the flat `inlines[]` array. `url` is a markdown image target; `page` is a
// wikilink target with its alias and `#fragment` already stripped. (The installed release
// binary omits the debug build's raw `target`, but `page` equals
// `normalizeEdgeTarget(target.split("|")[0])` on every embed, so keying on `page` is
// equivalent.) Inlines inside code spans/fences are NOT emitted — the payload-in-code
// false-positive the swap fixes.
export interface MdInline {
  type: string;
  url?: string;
  page?: string;
  embed?: boolean;
  span?: Span;
}

// A heading node in the `headings[]` tree (mirrors the binary's JSON: the key is `level`,
// not `depth` — Section.depth is derived from it in text.ts::sections). `span` is the heading
// line itself (ATX marker + text, or a setext text-line + its underline); `textSpan` is the
// title text alone (trailing `#` markers and whitespace excluded); `startLine` is 1-indexed
// (setext headings start on their text line). `sectionSpan` is the heading's whole subtree
// (start → end of everything under it) — it NESTS, so text.ts::sections takes disjoint bodies
// (heading start → next heading start) rather than reading it. `children` are the sub-headings.
export interface Heading {
  level: number;
  span: Span;
  textSpan: Span;
  startLine?: number;
  sectionSpan?: Span;
  children?: Heading[];
}

// A comment-anchor region in the `regions[]` array (mirrors the binary's `Region` JSON).
// Extraction is always-on and complete: one entry is emitted for every
// `<!-- <label>[: <info>] -->` … `<!-- /<label> -->` anchor pair (anchors inside fenced or inline
// code are inert). Consumers filter by `label`. `span` covers both anchor lines; `bodySpan` is the
// raw bytes between them; `info` is the whole post-`<label>:` string. Regions reference a span
// WITHOUT disturbing structure — the interior is still parsed into nodes/headings.
export interface MdRegion {
  type: string;
  label: string;
  info?: string;
  span: Span;
  bodySpan: Span;
  startLine: number;
  endLine: number;
}

// The whole document mdstruct parses from one note: its schema version, the block-node tree,
// the flat inline list, the heading tree, and the comment-anchor regions. Any field may be
// absent when the binary emits nothing for that lane (e.g. a note with no regions).
interface MdDoc {
  schemaVersion?: string;
  nodes?: MdNode[];
  inlines?: MdInline[];
  headings?: Heading[];
  regions?: MdRegion[];
}

// The `mdstruct` JSON schema this module is written against (the binary's
// `SCHEMA_VERSION`, camelCased on the wire as `schemaVersion`). parseDoc asserts
// an exact match: a stale binary on PATH emits an older version and silently
// returns pre-mask `regions[]` (phantom regions from anchors buried in indented
// code or multi-line HTML comments), which every present and future parse-only
// consumer (interact, highlight) would trust blind. The handshake turns that
// silent deploy-skew into a loud "rebuild mdstruct" failure. Bump in lockstep
// with the Rust `SCHEMA_VERSION` whenever this module depends on the new shape.
const EXPECTED_SCHEMA_VERSION = "1.2";

// The result of parseDoc: the parsed `doc` paired with the raw UTF-8 `buf` its byte spans
// index into (sliceBytes reads spans off `buf`, never off the original JS string).
export interface ParsedDoc {
  doc: MdDoc;
  buf: Buffer;
}

// Parse cache keyed by source text alone. distill is a one-shot CLI per note, so unbounded is fine.
// payloadResidue runs the four lanes over two texts -> 2 parses, not 8.
const cache = new Map<string, ParsedDoc>();

// The single injection seam: spawn `MDSTRUCT_BIN` (PATH-resolved) with `args`, feeding `text` on
// stdin, and return its stdout. A spawn failure (missing binary) throws `mdstruct unavailable` —
// the fail-loud contract both call sites share, so neither degrades to regex. With `recoverNonzero`,
// a ran-but-nonzero exit (numeric status) returns the child's stdout instead of throwing, so
// checkRegion recovers its ndjson from a byte-integrity exit 4; parseDoc omits the flag and lets a
// nonzero exit propagate. `stdio` overrides the default streams (checkRegion drops the child's
// stderr summary so only ndjson reaches the pipeline).
function runMdstruct(
  text: string,
  args: string[],
  opts: { recoverNonzero?: boolean; stdio?: StdioOptions } = {},
): string {
  const bin = MDSTRUCT_BIN;
  try {
    return execFileSync(bin, args, {
      input: text,
      encoding: "utf8",
      maxBuffer: MDSTRUCT_MAX_BUFFER,
      ...(opts.stdio ? { stdio: opts.stdio } : {}),
    });
  } catch (e) {
    const err = e as { status?: number | null; stdout?: string };
    // A ran-but-nonzero exit (e.g. byte-integrity 4) still wrote to stdout; recover it when asked.
    // A spawn failure has no numeric status -> fail loud so the binary never silently degrades.
    if (opts.recoverNonzero && typeof err.status === "number") {
      return typeof err.stdout === "string" ? err.stdout : "";
    }
    throw new Error(
      `mdstruct unavailable: could not run '${bin}' (${(e as Error).message}). ` +
        "The payload-residue gate needs the mdstruct binary on PATH; it must not degrade to regex.",
    );
  }
}

// Parse `text` to { doc, buf }. Spawns the bare name `mdstruct` (PATH-resolved, the
// polish.ts:167 mktemp pattern). Throws `mdstruct unavailable` on a missing binary or
// unparseable output (see the fail-loud note up top).
//
// Region extraction is always-on and fence-aware in the binary: every comment-anchor pair
// surfaces in `doc.regions` (anchors inside fenced or inline code are inert), with no flags to
// pass. Consumers filter `doc.regions` by label.
export function parseDoc(text: string): ParsedDoc {
  const key = text;
  const hit = cache.get(key);
  if (hit) return hit;
  const buf = Buffer.from(text, "utf8");
  const bin = MDSTRUCT_BIN;
  const stdout = runMdstruct(text, ["-"]);
  const line = stdout.split("\n").find((l) => l.trim());
  if (!line) throw new Error("mdstruct unavailable: empty output from 'mdstruct'");
  let doc: MdDoc;
  try {
    doc = JSON.parse(line) as MdDoc;
  } catch (e) {
    throw new Error(
      `mdstruct unavailable: unparseable NDJSON from 'mdstruct' (${(e as Error).message})`,
    );
  }
  // Exact-match against EXPECTED_SCHEMA_VERSION — see its own comment for why a mismatch
  // must fail loud rather than silently trust a stale binary's output.
  if (doc.schemaVersion !== EXPECTED_SCHEMA_VERSION) {
    throw new Error(
      `mdstruct schema mismatch: binary '${bin}' emitted schemaVersion ` +
        `${JSON.stringify(doc.schemaVersion)}, this build expects ` +
        `"${EXPECTED_SCHEMA_VERSION}". Rebuild mdstruct (the installed binary is stale).`,
    );
  }
  const parsed: ParsedDoc = { doc, buf };
  cache.set(key, parsed);
  return parsed;
}

// Slice `buf` by a byte `Span` and decode the `[start, end)` range as UTF-8.
export function sliceBytes(buf: Buffer, span: Span): string {
  return buf.subarray(span[0], span[1]).toString("utf8");
}

// A scoped dangling-anchor diagnostic from `mdstruct check --region <label> --format ndjson`.
// `type` is the pairing failure; `span` is the byte range of the offending anchor comment
// (a `{start,end}` OBJECT in the ndjson, normalized here to the `[start, end)` tuple the rest
// of this module uses); `line` is its 1-indexed line. Consumers map the two kinds to their own
// error vocabulary (interact: unpaired-open -> unclosed-block, unpaired-close -> unopened-close).
export interface RegionDiagnostic {
  type: "unpaired-open" | "unpaired-close";
  label: string;
  span: Span;
  line: number;
}

// Run the freeze-gate's dangling-anchor reporter for a single label over `text` on stdin.
// Shells `mdstruct check --region <label> --format ndjson -` and parses the stdout ndjson
// records (one per scoped dangling anchor). Keys are read by NAME (serde emits them
// alphabetically, so positional order is not relied on). This is the ONE Rust engine's view of
// unpaired anchors; callers never re-scan for fences themselves.
//
// Dangling anchors are non-fatal (exit 0), so `check` normally returns cleanly. A byte-integrity
// failure exits 4 (execFileSync throws), but its dangling records are still on stdout, so the
// records are recovered from the thrown error rather than lost. A spawn failure (missing binary)
// throws `mdstruct unavailable`, matching parseDoc's fail-loud contract.
export function checkRegion(text: string, label: string): RegionDiagnostic[] {
  const args = ["check", "--region", label, "--format", "ndjson", "-"];
  // recoverNonzero: a byte-integrity exit 4 still wrote the ndjson to stdout, so keep it. stdio
  // drops the child's stderr `N/N files passed` summary — interact only wants the ndjson on stdout.
  const stdout = runMdstruct(text, args, {
    recoverNonzero: true,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const out: RegionDiagnostic[] = [];
  for (const raw of stdout.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let rec: {
      type?: string;
      label?: string;
      span?: { start?: number; end?: number };
      line?: number;
    };
    try {
      rec = JSON.parse(trimmed);
    } catch {
      // Intentional lossy-tolerant parse: a malformed line (partial write, stray
      // non-ndjson output) is dropped rather than thrown. checkRegion is a
      // best-effort diagnostic scan, not a source of truth — losing one record
      // beats aborting the whole dangling-anchor report over a single bad line.
      continue;
    }
    if (
      (rec.type === "unpaired-open" || rec.type === "unpaired-close") &&
      rec.span &&
      typeof rec.span.start === "number" &&
      typeof rec.span.end === "number" &&
      typeof rec.line === "number"
    ) {
      out.push({
        type: rec.type,
        label: rec.label ?? label,
        span: [rec.span.start, rec.span.end],
        line: rec.line,
      });
    }
  }
  return out;
}

// Depth-first walk calling `fn` on every node, recursing into `children` EXCEPT types in
// `noDescend` — the blockquote lane passes `{blockQuote}` so a nested `> >` quote isn't
// double-counted (matching the regex `>`-run merge).
export function walkNodes(
  nodes: MdNode[] | undefined,
  fn: (n: MdNode) => void,
  noDescend: Set<string> = new Set(),
): void {
  for (const n of nodes ?? []) {
    fn(n);
    if (n.children && !noDescend.has(n.type)) walkNodes(n.children, fn, noDescend);
  }
}

// Pre-order walk of the `headings[]` tree (parent before children) — the `Heading` analogue of
// walkNodes, kept here so both `children`-bearing trees this parse owns share one traversal.
export function walkHeadings(headings: Heading[] | undefined, fn: (h: Heading) => void): void {
  for (const h of headings ?? []) {
    fn(h);
    walkHeadings(h.children, fn);
  }
}
