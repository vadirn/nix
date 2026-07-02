// writing/prose-qa — an independent judge for the connective prose. The prose is
// the un-gated readable head; it carries its own contract from connectiveProsePrompt
// (thesis-first opening, no document self-reference, no closing meta-summary, no
// AI vocabulary) that the generic revise pass enforces unreliably. A DIFFERENT
// model than the writer (the FIDELITY model judges the EXTRACT model's prose,
// mirroring the fidelity gate) flags those defects; one fix pass repairs them.
// This sits BELOW the fidelity line — prose defects never block output, they are
// repaired best-effort.
import { langRule } from "../text.ts";
import {
  askJson,
  EXTRACT,
  EXTRACT_TOKENS,
  FIDELITY,
  FIDELITY_TOKENS,
  rethrowIfBug,
} from "../fw.ts";

function proseJudgePrompt(thesis: string, prose: string): string {
  return `You are an independent prose editor. You did NOT write this text. Judge ONLY these four defects and ignore everything else:
1. CLOSING META-SUMMARY: a final paragraph that summarizes, ties together, or comments on the preceding text ("Thus, the interplay of these concepts...", "In summary...", "Together, these ideas...") rather than stating a fact about the subject.
2. DOCUMENT SELF-REFERENCE: any mention of "the note", "this note", "the text", "the thesis", "this concept", "the author", or any description of what the text itself does.
3. AI VOCABULARY: interplay, tapestry, underscore, delve, leverage, robust, intricate, navigate, realm, landscape, multifaceted, seamless, pivotal, and similar.
4. OPENING: the FIRST sentence must assert the thesis as a plain claim about the subject; flag it if instead it announces the topic ("This covers...", "Here we explore...").
Return ONLY JSON {"pass":true|false,"issues":["specific located finding", ...]}. pass=true ONLY when there are zero defects. Each issue names the exact offending span and which defect it is.

THESIS: ${thesis}

PROSE:
${prose}`;
}

export async function proseJudge(
  thesis: string,
  prose: string,
): Promise<{ pass: boolean; issues: string[] }> {
  try {
    const r = await askJson<{ pass?: boolean; issues?: string[] }>(
      FIDELITY,
      proseJudgePrompt(thesis, prose),
      FIDELITY_TOKENS,
    );
    return {
      pass: r.pass !== false,
      issues: (r.issues ?? []).filter((s) => typeof s === "string"),
    };
  } catch (e) {
    rethrowIfBug(e, "proseJudge");
    return { pass: true, issues: [] }; // a transient judge flake never blocks the prose
  }
}

// The fix pass is NOT revise(): revise is forbidden from dropping content, but a
// closing meta-summary must be DELETED, not reworded. This pass permits deletion
// while freezing every claim, bold term span, and verbatim token.
function proseFixPrompt(prose: string, issues: string[], lang: "en" | "ru"): string {
  return `You are a copy editor. Rewrite the PROSE below to fix EXACTLY these issues and change nothing else. You MAY delete whole sentences or paragraphs that are pure meta-summary or AI filler — for a closing summary paragraph, deletion is preferred over rewording. Preserve every factual claim about the subject, keep the thesis-first opening, and reproduce all **bold** term spans, \`inline code\`, file paths, and [[wikilink]] targets verbatim. ${langRule(lang)} Return ONLY JSON {"prose":"..."}.

ISSUES:
${issues.map((s) => `- ${s}`).join("\n")}

PROSE:
${prose}`;
}

export async function proseFix(
  prose: string,
  issues: string[],
  lang: "en" | "ru",
): Promise<string> {
  try {
    const r = await askJson<{ prose?: string }>(
      EXTRACT,
      proseFixPrompt(prose, issues, lang),
      EXTRACT_TOKENS,
    );
    return (r.prose ?? "").trim() || prose; // an empty fix keeps the prior prose
  } catch (e) {
    rethrowIfBug(e, "proseFix");
    return prose; // a transient fix flake keeps the prior prose
  }
}
