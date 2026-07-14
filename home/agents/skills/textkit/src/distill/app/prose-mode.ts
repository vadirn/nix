// prose-mode — the inverse flow: reconstruct a readable prose note from an
// already-distilled note's concepts. Input is a distilled file (this tool's own
// output, or a saved canonical note): frontmatter + a `## Abstract` orientation + a
// `## Concepts` section of `### headword` definitions + optional other sections
// (`## Procedures` / `## Payload` / `## Relations` …). Output is a flowing prose note
// grounded ONLY in the abstract + concepts, with the `## Concepts` section folded into
// the prose and dropped from output (the abstract seeds the thesis/tie) — every other
// section passes through verbatim. No fidelity gate: the canonical note is the
// certified artifact, and the prose is its readable derivative, always regenerable and
// checkable against it.
import { detectLang, glossList, langRule, segment, wordCount } from "@/core/text.ts";
import { parseDescription, parseFrontmatter } from "@/core/frontmatter.ts";
import { askJson, EXTRACT, EXTRACT_TOKENS, rethrowIfBug } from "@/core/fw.ts";
import { PASS_EN, PASS_RU, revise } from "@/distill/prompt/prompts.ts";
import { parseCanonicalNote, splitSections } from "@/distill/graph/parse-projection.ts";
import { unwrapResult } from "@/distill/app/envelope.ts";

// Parse a distilled body into its parts: the tie-together prose (the `## Abstract`
// orientation), the concept entries (each `### headword` under `## Concepts`, its
// first-line definition stripped of the trailing byte-anchor), and the preserved
// sections (every OTHER `## ` section verbatim — `## Procedures`, `## Payload`,
// `## Relations`, a wikilink reference list, …). The `## Concepts` section is the only
// region reconstructed into prose; every other section is passed through verbatim, so a
// `## Procedures` list is never folded into the prose. Reads the canonical shape via the
// shared parse-projection reader, projecting into its own local `{term,def}[]` type.
export function parseDistilled(body: string): {
  tie: string;
  entries: { term: string; def: string }[];
  preserved: string;
} {
  const note = parseCanonicalNote(body);
  // Hardening: a `### headword` with no definition line is malformed output — the model
  // dropped or split a subsection. Skip it rather than feed an empty-def entry into the
  // render prompt (symmetric with the empty-headword guard).
  const entries = note.concepts
    .filter((c) => c.headword && c.def)
    .map((c) => ({ term: c.headword, def: c.def }));
  const preserved = splitSections(body)
    .filter((s) => s.name !== "abstract" && s.name !== "concepts")
    .map((s) => [`## ${s.heading}`, ...s.bodyLines].join("\n").trim())
    .filter((s) => s.length > 0)
    .join("\n\n");
  return { tie: note.abstract, entries, preserved };
}

// Build the reconstruction prompt: instructs the model to write flowing prose from ONLY
// the description, thesis, and glossary definitions below, with no glossary/table/bullet
// list or section headings in the output. `glossList` renders `entries` as the glossary block.
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

// Renders the prose form of a glossary entry set via a single LLM call (never
// per-entry). Local to runProse below — apply-mode's def-recover path leaves the
// `## Abstract` as-authored instead of re-projecting through this chain (see apply-mode.ts).
async function renderProse(
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
      emit(input, "— prose skipped: no ## Concepts section found");
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
