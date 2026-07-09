// mdstruct — the CLI-wrapper seam between distill's structural payload harvesters and
// the nix-installed `mdstruct` binary (comrak-backed markdown structural core → NDJSON).
// The four structural payload lanes in text.ts (fences, blockquotes, table rows, image
// embeds) locate their spans through THIS module instead of hand-rolled line-scanning
// regex; the Backlog-1 spike proved span-fed key reproduction is byte-identical to the
// old regex over 998 vault files, and the Backlog-9 gate proved the swap only REMOVES
// false residue (payload documented inside code, nested fences, list-nested quotes) and
// never corrupts a real key. Only the LOCATOR moved here; the key-normalization stays in
// text.ts, unchanged (that is what the gate validated).
//
// FAIL LOUD: a missing or unparseable binary throws `mdstruct unavailable`, never a silent
// regex fallback — residue is a correctness gate (it tells the user real payload was
// dropped), so a degraded locator would reintroduce the very bugs this fixes and read as
// fail-open (cf. PR #76 closing fail-open PreToolUse guards). A hard dependency that
// surfaces beats a soft one that lies.
import { execFileSync } from "node:child_process";

// A `[startByte, endByte)` byte offset pair into the ORIGINAL source buffer. Every slice
// runs on Buffer bytes, never JS UTF-16 string indices — the Backlog-1 spike proved
// Cyrillic round-trips byte-exact only on a Buffer (a `.png`-terminal Cyrillic fence
// mis-slices under string indexing).
export type Span = [number, number];

// A block node in mdstruct's `nodes[]` tree. Only the fields the four harvesters read are
// typed (not `any`); comrak nests blocks under lists/quotes, so `children` is walked
// recursively by walkNodes. `bodySpan` is the fence's inner body (info-string and fences
// excluded); `span` is the whole node.
export interface MdNode {
  type: string;
  fenced?: boolean;
  bodySpan?: Span;
  span?: Span;
  startLine?: number;
  endLine?: number;
  children?: MdNode[];
}

// An inline in mdstruct's flat `inlines[]` array. `url` is a markdown image target;
// `page` is a wikilink's target with its alias and `#fragment` already stripped (the
// installed schema-1.0 binary's field — the debug build also carries a raw `target`, but
// `page` equals normalizeEdgeTarget(target.split("|")[0]) on every embed, so keying on
// `page` is gate-equivalent and works on the PATH binary). `embed` marks a `![[…]]`
// transclusion. Inlines inside code spans/fences are NOT emitted — that is the payload-in-
// code false-positive the swap fixes.
export interface MdInline {
  type: string;
  url?: string;
  page?: string;
  embed?: boolean;
  span?: Span;
}

export interface MdDoc {
  nodes?: MdNode[];
  inlines?: MdInline[];
}

export interface ParsedDoc {
  doc: MdDoc;
  buf: Buffer;
}

// Parse cache keyed by source text. distill is a short-lived one-shot CLI per note, so an
// unbounded Map is fine (the process exits before it grows). payloadResidue(source, output)
// runs the four lanes over two texts; the cache makes that 2 parses total, not 8.
const cache = new Map<string, ParsedDoc>();

// Parse `text` through the mdstruct CLI to { doc, buf }. `buf` is the source's UTF-8 bytes
// (the slice substrate); `doc` is the first NDJSON line. Spawns the bare name `mdstruct`
// (PATH-resolved, the exact pattern polish.ts:167 uses for `mktemp`). Throws
// `mdstruct unavailable` on a missing binary or unparseable output — see the fail-loud note
// at the top of the file.
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

// Slice a byte span out of the source buffer as UTF-8. Byte offsets ONLY (never JS-string
// indices) — the Cyrillic-fidelity invariant this whole module exists to hold.
export function sliceBytes(buf: Buffer, span: Span): string {
  return buf.subarray(span[0], span[1]).toString("utf8");
}

// Depth-first pre-order walk of a block-node tree, calling `fn` on every node. Recurses into
// `children` (a fence indented under a list item is a CHILD node, not top-level — a spike
// lesson) EXCEPT for types in `noDescend` (the blockquote lane passes `{blockQuote}` so a
// nested `> >` quote is not double-counted, matching the regex `>`-run merge).
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
