// prose-mode — the inverse flow: reconstruct a readable prose note from an
// already-distilled glossary. No fidelity gate (the glossary is the certified
// artifact); the prose is its regenerable derivative.
import { detectLang, glossList, langRule, segment, wordCount } from "./text.ts";
import { parseDescription, parseFrontmatter } from "./frontmatter.ts";
import { askJson, EXTRACT, EXTRACT_TOKENS, rethrowIfBug } from "./fw.ts";
import { PASS_EN, PASS_RU, revise } from "./prompts.ts";

// ---- prose mode: reconstruct a prose note from a distilled glossary ----
// The inverse of the compress pipeline. Input is a distilled file (this tool's
// own output, or a saved glossary note): frontmatter + a tie-together line + a
// `## Glossary` table + optional retained blocks. Output is a flowing prose note
// grounded ONLY in that glossary — the certified reference. No fidelity gate: the
// glossary is the certified artifact, the prose its readable derivative (always
// regenerable and checkable against it). The glossary table is dropped from output.

// If the input is wrapped in <result>…</result> (the raw temp file this tool
// emits), use the inner content and ignore any <residue>; otherwise use as-is.
function unwrapResult(text: string): string {
  const m = text.match(/<result>\r?\n?([\s\S]*?)\r?\n?<\/result>/);
  return m ? m[1] : text;
}

const stripH1 = (s: string): string => s.replace(/^#\s+[^\n]*\r?\n?/, "");

// Parse a distilled body into its parts: the tie-together prose (head, minus any
// H1), the glossary entries (the `## Glossary` table — header/separator rows
// skipped, `\|` unescaped, the inverse of escCell + assembleBody), and the
// preserved tail (everything else after the head: a `## Workflow` section, a
// wikilink reference list, …). Order-independent: the glossary may sit before or
// after the workflow section. The glossary table is the only region reconstructed
// into prose; every other section is passed through verbatim, so a `## Workflow`
// list is never folded into the prose regardless of where it appears.
export function parseDistilled(body: string): {
  tie: string;
  entries: { term: string; def: string }[];
  preserved: string;
} {
  const lines = body.split("\n");
  const isHeading = (s: string) => /^##\s/.test(s.trim());
  const glossLine = lines.findIndex((l) => /^##\s+Glossary\b/i.test(l.trim()));
  if (glossLine < 0) {
    return { tie: stripH1(body).trim(), entries: [], preserved: "" };
  }
  // head: everything before the FIRST `## ` section (prose may precede a workflow
  // section that itself precedes the glossary). tie is that head minus any H1.
  let firstHeading = lines.findIndex(isHeading);
  if (firstHeading < 0) firstHeading = glossLine;
  const head = lines.slice(0, firstHeading).join("\n");
  // the glossary table: contiguous `|` rows after the glossary heading
  const rows: string[] = [];
  let j = glossLine + 1;
  for (; j < lines.length; j++) {
    const t = lines[j].trim();
    if (t === "") {
      if (rows.length) break; // a blank after the rows ends the table
      continue; // blank between heading and table
    }
    if (t.startsWith("|")) {
      rows.push(t);
      continue;
    }
    break; // first non-blank non-row line ends the table
  }
  // preserved = the sections between head and the glossary heading + everything
  // after the glossary table, with the glossary heading+table region excised.
  const before = lines.slice(firstHeading, glossLine).join("\n").trim();
  const after = lines.slice(j).join("\n").trim();
  const preserved = [before, after].filter(Boolean).join("\n\n");
  const entries: { term: string; def: string }[] = [];
  for (const row of rows) {
    const cells = row
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split(/(?<!\\)\|/)
      .map((c) => c.replace(/\\\|/g, "|").trim());
    if (cells.length < 2) continue;
    const [term, def] = cells;
    if (!term || term.toLowerCase() === "term") continue; // header row
    if (/^:?-{3,}:?$/.test(term.replace(/\s/g, ""))) continue; // separator row
    // Hardening: a term with no definition is malformed glossary output — the
    // model dropped or split a row. Skip it rather than feed an empty-def entry
    // into the render prompt (symmetric with the empty-term guard above).
    if (!def) continue;
    entries.push({ term, def });
  }
  return { tie: stripH1(head).trim(), entries, preserved };
}

function renderPrompt(
  description: string,
  tie: string,
  entries: { term: string; def: string }[],
  lang: "en" | "ru",
): string {
  const gloss = glossList(entries);
  return `You are reconstructing a readable prose note from its distilled glossary. Write flowing prose (connected markdown paragraphs) using ONLY the description, thesis, and glossary definitions below, drawing every claim, term, and example from them. Do NOT emit a glossary, a table, a bullet list of the terms, or section headings; write paragraphs a reader follows start to finish. Lead with the thesis, then develop each concept and how it relates to the others. ${langRule(lang)} Return ONLY JSON {"prose":"..."}.

DESCRIPTION: ${description || "(none)"}

THESIS / TIE:
${tie || "(none)"}

GLOSSARY:
${gloss}`;
}

// Exported for apply-mode.ts (Phase 4): a checked `recover:` that re-renders ≥1
// glossary def changes the certified artifact, so apply re-projects the head prose
// from the whole updated entry set — one call, never per-entry (residue-render
// reader). Removal-only and keep-only applies never reach it (they stay offline).
export async function renderProse(
  description: string,
  tie: string,
  entries: { term: string; def: string }[],
  lang: "en" | "ru",
): Promise<string> {
  const res = await askJson<{ prose: string }>(
    EXTRACT,
    renderPrompt(description, tie, entries, lang),
    EXTRACT_TOKENS,
  );
  return (res.prose ?? "").trim();
}

// Drive render mode: parse → synthesize prose → revise (no gate) → assemble.
// Failsafe mirrors the compress path: any error → the original is passed through.
// Returns the process exit code: 0 rendered, 3 skipped (output = unmodified
// input, same contract as a compress passthrough; the reason goes to stderr).
export async function runProse(
  input: string,
  opts: { lang: "en" | "ru" | "auto"; noRevise: boolean },
  emit: (body: string, footer: string) => void,
): Promise<number> {
  try {
    const { front, body } = parseFrontmatter(unwrapResult(input));
    const { tie, entries, preserved } = parseDistilled(body);
    if (entries.length === 0) {
      emit(input, "— prose skipped: no ## Glossary table found");
      return 3;
    }
    const lang = opts.lang === "auto" ? detectLang(body) : opts.lang;
    let prose = await renderProse(parseDescription(front), tie, entries, lang);
    if (!prose) {
      emit(input, "— prose skipped: empty prose");
      return 3;
    }
    if (!opts.noRevise) {
      const revised = await revise(segment(prose), lang === "ru" ? PASS_RU : PASS_EN);
      prose = revised.map((b) => b.text).join("\n\n");
    }
    const outBody = preserved ? `${prose}\n\n${preserved}` : prose;
    const result = front ? front + "\n" + outBody : outBody;
    emit(
      `<result>\n${result}\n</result>\n`,
      `— rendered prose · ${wordCount(body)}→${wordCount(outBody)} words · ${entries.length} entries`,
    );
    return 0;
  } catch (e) {
    rethrowIfBug(e, "runProse");
    emit(input, `— prose skipped (error): ${String(e).slice(0, 160)}`);
    return 3;
  }
}
