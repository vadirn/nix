// envelope — the `<result>…</result>` XML envelope grammar that carries a
// distilled/passthrough note (plus an optional `<residue>` sibling) to a parent
// process across a temp-file boundary. The writer half (escAttr + the
// passthrough assembler) and the reader half (unwrapResult) previously lived
// apart — the writer buried in distill-core's dispatch code, the reader in
// prose-mode.ts, which re-consumes this tool's own output as its input. Both
// halves of the grammar now sit together here.
import { ensureEpistemicStatus } from "./frontmatter.ts";
import type { Residue } from "./residue.ts";

// Escape the three characters an XML attribute value cannot carry raw. The passthrough envelope
// (distill-core's main(), the exit-3 legacy sink) stamps residue labels/reasons into
// `<entry term=… reason=…>`.
const escAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

// The legacy passthrough envelope (the exit-3 sink): the unmodified source, epistemic-status
// stamped, wrapped in <result>…</result> with an optional <residue> block of escaped entries.
// Pure — main()'s passthrough branch emits this verbatim beside its footer.
export function buildPassthroughEnvelope(front: string, out: string, residue: Residue[]): string {
  const front2 = ensureEpistemicStatus(front);
  const result = front2 ? front2 + "\n" + out : out;
  let fileBody = `<result>\n${result}\n</result>\n`;
  if (residue.length) {
    const entries = residue
      .map(
        (r) =>
          `<entry term="${escAttr(r.label)}" reason="${escAttr(r.reason)}">\n<source>\n${r.source}\n</source>\n</entry>`,
      )
      .join("\n");
    fileBody += `\n<residue>\n${entries}\n</residue>\n`;
  }
  return fileBody;
}

// Unwrap a <result>…</result> envelope (the raw temp file this tool emits) to its inner
// content, discarding any sibling <residue> block; text with no envelope is returned unchanged.
export function unwrapResult(text: string): string {
  const m = text.match(/<result>\r?\n?([\s\S]*?)\r?\n?<\/result>/);
  return m ? m[1] : text;
}
