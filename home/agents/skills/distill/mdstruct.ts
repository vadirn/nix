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

export interface MdDoc {
  nodes?: MdNode[];
  inlines?: MdInline[];
  headings?: Heading[];
}

export interface ParsedDoc {
  doc: MdDoc;
  buf: Buffer;
}

// Parse cache keyed by source text. distill is a one-shot CLI per note, so unbounded is fine.
// payloadResidue runs the four lanes over two texts → 2 parses, not 8.
const cache = new Map<string, ParsedDoc>();

// Parse `text` to { doc, buf }. Spawns the bare name `mdstruct` (PATH-resolved, the
// polish.ts:167 mktemp pattern). Throws `mdstruct unavailable` on a missing binary or
// unparseable output (see the fail-loud note up top).
export function parseDoc(text: string): ParsedDoc {
  const hit = cache.get(text);
  if (hit) return hit;
  const buf = Buffer.from(text, "utf8");
  let stdout: string;
  try {
    stdout = execFileSync("mdstruct", ["-"], {
      input: text,
      encoding: "utf8",
      maxBuffer: 1 << 28,
    });
  } catch (e) {
    throw new Error(
      `mdstruct unavailable: could not run 'mdstruct' (${(e as Error).message}). ` +
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
  const parsed: ParsedDoc = { doc, buf };
  cache.set(text, parsed);
  return parsed;
}

export function sliceBytes(buf: Buffer, span: Span): string {
  return buf.subarray(span[0], span[1]).toString("utf8");
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
