// mdstruct — the CLI-wrapper seam: distill's four structural payload harvesters (fences,
// blockquotes, table rows, image embeds) locate their spans through this module instead of
// line-scanning regex. Only the LOCATOR moved here; the key-normalization stays in text.ts.
//
// Fail-loud: a missing or unparseable binary throws `mdstruct unavailable` rather than
// degrading to regex. Residue is a correctness gate (it tells the user real payload was
// dropped), so a silent fallback would reintroduce the very bugs this fixes.
import { execFileSync } from "node:child_process";

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
// wikilink target with its alias and `#fragment` already stripped. (The installed schema-1.0
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

export interface MdDoc {
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

export interface ParsedDoc {
  doc: MdDoc;
  buf: Buffer;
}

// Parse cache keyed by source text alone. distill is a one-shot CLI per note, so unbounded is fine.
// payloadResidue runs the four lanes over two texts -> 2 parses, not 8.
const cache = new Map<string, ParsedDoc>();

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
  const args = ["-"];
  // MDSTRUCT_BIN overrides the bare-name PATH resolution so tests can point at a freshly-built
  // binary (with newer flags); production leaves it unset and resolves `mdstruct` on PATH.
  const bin = process.env.MDSTRUCT_BIN ?? "mdstruct";
  let stdout: string;
  try {
    stdout = execFileSync(bin, args, {
      input: text,
      encoding: "utf8",
      maxBuffer: 1 << 28,
    });
  } catch (e) {
    throw new Error(
      `mdstruct unavailable: could not run '${bin}' (${(e as Error).message}). ` +
        "The payload-residue gate needs the mdstruct binary on PATH; it must not degrade to regex.",
    );
  }
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
  // Schema-version handshake: fail loud on deploy skew rather than trust a stale
  // binary's pre-mask regions. Exact-match against the version this module was
  // written for (see EXPECTED_SCHEMA_VERSION).
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
  const bin = process.env.MDSTRUCT_BIN ?? "mdstruct";
  const args = ["check", "--region", label, "--format", "ndjson", "-"];
  let stdout: string;
  try {
    stdout = execFileSync(bin, args, {
      input: text,
      encoding: "utf8",
      maxBuffer: 1 << 28,
      // The `check` verb writes its `N/N files passed` summary (and any warn lines) to stderr;
      // interact only wants the ndjson diagnostics on stdout, so drop the child's stderr rather
      // than let it inherit onto the pipeline's stderr.
      stdio: ["pipe", "pipe", "ignore"],
    });
  } catch (e) {
    const err = e as { status?: number | null; stdout?: string };
    // A ran-but-nonzero exit (e.g. byte-integrity 4) still wrote the ndjson to stdout; recover it.
    // A spawn failure has no numeric status -> fail loud like parseDoc.
    if (typeof err.status === "number") {
      stdout = typeof err.stdout === "string" ? err.stdout : "";
    } else {
      throw new Error(
        `mdstruct unavailable: could not run '${bin} check' (${(e as Error).message}). ` +
          "interact's unclosed/unopened validation needs the mdstruct binary on PATH.",
      );
    }
  }
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
