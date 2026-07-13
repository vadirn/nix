// route — the per-section density router (D12/D2; the --dry-run + Backlog 10 spine).
// Splits a note into heading-delimited sections and routes each on its own payload
// density: the SAME structural-payload detection that feeds the residue gate and the
// protected-span set (harvest.ts::structuralSpans) is reused HERE (D2 "one harvest,
// three uses") to MASK payload and measure the prose word-share that remains. High
// payload-share → preserve (structural compaction); low → re-author (compact prose).
// Deterministic and free — no LLM. Sits a tier above harvest.ts + text.ts and never
// cycles back into them (text.ts re-exports `sections` only as a compat shim for cards/).
import { parseDoc, sliceBytes, walkHeadings, type Heading } from "./mdstruct.ts";
import { DISPLAY_MATH_PATTERNS, structuralSpans } from "./harvest.ts";
import { wordCount } from "./text.ts";

export type Section = { heading: string; depth: number; text: string };
export type Route = "re-author" | "preserve";

// Starting threshold only — the real value is calibrated against 00 inbox/ via --dry-run
// (Backlog 7/9). A section whose payload word-share meets τ routes to preserve.
export const DEFAULT_TAU = 0.5;

// Flatten the mdstruct headings tree to a flat list in tree order (parent before children),
// reusing mdstruct's walkHeadings so the traversal lives in one place.
function flattenHeadings(hs: Heading[] | undefined): Heading[] {
  const out: Heading[] = [];
  walkHeadings(hs, (h) => out.push(h));
  return out;
}

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
