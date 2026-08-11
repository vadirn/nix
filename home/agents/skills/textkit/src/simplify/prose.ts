// simplify/prose — the one place the two Simplified scans get their prose. wordcap measures a
// sentence's length and sequence measures its members, and both must read only the bytes a restyle
// may rewrite. So "which bytes of this note are prose" is answered once, here, off mdstruct's
// parse, and each scan states its own skip policy over that one answer.
//
// The parse settles four questions the line scans it replaces had to guess at.
//
// A paragraph carrying a bare `|` stays a `paragraph`, so prose that mentions a pipe is measured.
// Both scans used to drop such a line on a bare `/\|/` test, commented "table row (or any
// cell-delimited line)" — one defect, spelled twice, that removed real prose from both halves of
// one brief.
//
// A real table emits `table` → `tableRow` → `tableCell` and no paragraph at all, so it is skipped
// without any pipe test. That is why losing the test costs nothing.
//
// A fence is a `codeBlock` wherever it sits: at the top level, inside a blockquote, or indented
// inside a list item. The old `stripFences` blanked the first form only, so a blockquoted fence
// reached both scans as prose.
//
// A list item's paragraph starts AFTER the marker and after the GFM task box, so `- [ ] text`
// measures `text` with no marker strip, while a bare `[ ]` opening a paragraph keeps its brackets.
// `listItem` carries a `task` field, so the parser knows which of the two it is looking at. The
// regex could only infer it from whether a bullet preceded the box.
import { parseDoc, sliceBytes, walkNodes } from "textkit/core/mdstruct.ts";

// A paragraph's bytes read as ONE line. The span covers the paragraph's whole block, so a
// soft-wrapped paragraph carries the newlines and the continuation indent markdown puts there.
// Neither is prose. The indent would vanish into a `\s+` word split anyway, but the newline would
// not: a finding is printed into the prompt hint as one `- (N words) …` bullet, and an embedded
// newline breaks that bullet in two. Notes in this corpus are unwrapped — one paragraph per line,
// per segment() — so this normally joins nothing.
const oneRun = (text: string): string =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ");

// Every paragraph in `masked`, in document order, one prose run each. `skip` names the container
// node types the walk refuses to DESCEND into; the container itself is never a paragraph, so
// naming it here drops its whole subtree. The two scans differ on exactly one entry — sequence
// refuses to reach into a list, wordcap measures the prose inside each item — so the policy is the
// caller's and the walk is shared.
//
// A heading needs no entry in any policy: mdstruct keeps headings in `headings[]` and out of
// `nodes[]` entirely, so a heading's text can never reach a scan.
//
// Not total, unlike the line scans it replaces: the parse shells out to the mdstruct binary and
// throws MdstructUnavailableError when it cannot run. Both callers sit under simplify-text, which
// parses the source before its first model call and maps that class to exit 5, so a missing binary
// stops the run before it spends a token.
export function proseParagraphs(masked: string, skip: Set<string>): string[] {
  const { doc, buf } = parseDoc(masked);
  const out: string[] = [];
  walkNodes(
    doc.nodes,
    (n) => {
      if (n.type === "paragraph" && n.span) out.push(oneRun(sliceBytes(buf, n.span)));
    },
    skip,
  );
  return out;
}
