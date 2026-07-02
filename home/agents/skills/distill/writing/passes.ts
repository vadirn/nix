// writing/passes — the four sequential writing passes (words → sentences →
// paragraphs → AI patterns) and the revise() stage that runs them, masking
// reference spans first so the rewriting model cannot reword or drop them.
import { type Block, render } from "../text.ts";
import { askJson, EXTRACT, EXTRACT_TOKENS, rethrowIfBug } from "../fw.ts";
import { createMasker } from "./mask.ts";
import { normalizeTypography } from "./typography.ts";

// ---- writing passes (the revise-stage rubric — inline single source) ----
// Four focused rule sets applied in sequence (words → sentences → paragraphs →
// AI patterns); each call refines the prior pass's output. These condensed rules
// are the whole rubric; there is no separate reference file to keep in sync.
export type Pass = { name: string; rules: string };

export const PASS_EN: Pass[] = [
  {
    name: "words",
    rules: `WORDS: turn nominalizations (-tion/-ment/-ance) into verbs; prefer the shortest word that means the same; cut filler ("it is important to note", "due to the fact that", "in order to"); use affirmative not negative forms ("is absent" not "is not present"); replace dead metaphors with literal statements; use everyday English over formal/Latin words ("use" not "utilize", "end" not "terminate").`,
  },
  {
    name: "sentences",
    rules: `SENTENCES: make the actor the subject; use active voice; get to the main verb within ~7 words; open with familiar information, close with the new; chain known→new across sentences; keep one topic per sentence; replace verbless fragments ("Fast, but fragile") with a subject+verb; split sentences carrying more than one idea, reconnect with a transition if the ideas depend on each other.`,
  },
  {
    name: "paragraphs",
    rules: `PARAGRAPHS: lead with the main point; keep one topic per paragraph; where headings are used, make them informative (not "Introduction"/"Discussion"), but do not add headings to prose that has none; explain prerequisites before the things that depend on them; keep paragraphs short enough to scan.`,
  },
  {
    name: "ai",
    rules: `AI PATTERNS: cut filler openings ("Here's how", "In this section", "Let's dive in"); replace promotional adjectives (innovative/robust/scalable/seamless) with facts; cut significance inflation ("pivotal moment", "underscores its significance"); restore plain copulas (is/has, not "serves as"/"boasts"/"represents"); cut canned constructions ("not just X but Y", rule-of-three padding); thin out AI vocabulary (delve, underscore, leverage, robust, intricate, tapestry, navigate); vary sentence length.`,
  },
];

export const PASS_RU: Pass[] = [
  {
    name: "words",
    rules: `СЛОВА: отглагольные существительные (-ание/-ение/-ция) → глаголы; выбирай короткое слово; убирай мусор («следует отметить», «ввиду того что», «в принципе», «таким образом»); утверждение вместо отрицания; мёртвые метафоры → конкретику; живой язык вместо канцелярита («использовать» вместо «осуществлять», «делать» вместо «производить»).`,
  },
  {
    name: "sentences",
    rules: `ПРЕДЛОЖЕНИЯ: деятель в подлежащем; активный залог; сказуемое ближе к началу (в предложениях длиннее 20 слов проверь); известное → начало, новое → конец; цепочка known-new между предложениями; единая тема в абзаце; безглагольные обрывки («Быстро, но хрупко») → подлежащее + сказуемое; одно предложение — одна мысль, разбей и склей если нужно.`,
  },
  {
    name: "paragraphs",
    rules: `АБЗАЦЫ: главное первым; один абзац — одна мысль; где есть заголовки — делай их конкретными (не «Введение»/«Заключение»), не добавляй заголовки в текст без них; объясняй предпосылки раньше того, что от них зависит; структурируй для сканирования (подзаголовки, списки, короткие абзацы).`,
  },
  {
    name: "ai",
    rules: `AI-ПАТТЕРНЫ: убирай маркеры («важно отметить», «в современном мире», «следует учитывать»); рекламные штампы → факты; раздувание значимости → конкретный факт; «является»/«представляет собой» → тире или прямой глагол; шаблонные конструкции («не просто X, а Y», тройка-перечисление) → скажи прямо; прорежай AI-лексику (подчёркивает, отражает, играет ключевую роль, ландшафт, палитра, многогранный); чередуй длину предложений; упрощай пунктуацию (больше трёх запятых — разбей на два).`,
  },
];

// ---- writing passes (stage 4): reuse cut's four sequential rewrites ----
function revisePrompt(blocks: Block[], pass: Pass): string {
  return `You are a copy editor. This is the ${pass.name.toUpperCase()} pass. Revise each block below applying only the rules below. Preserve its claims, keep all its content, and match the original's structure exactly (same headings, bullets, and formatting). Keep code blocks verbatim, and reproduce any ⟦N⟧ placeholder tokens unchanged. Preserve emphasis (**bold**, _italic_). Write straight quotes; keep em dashes (—) as written. Return ONLY JSON {"blocks":[{"id":"B1","text":"revised text"}, ...]} — one entry per block, ids matching.

${pass.rules}

TEXT:
${render(blocks)}`;
}

export async function revise(
  blocks: Block[],
  passes: Pass[],
  literals: string[] = [],
): Promise<Block[]> {
  // Mask reference spans ([[wikilinks]], ![[embeds]], inline code) to opaque ⟦N⟧
  // tokens before the passes so the rewriting model cannot reword or drop them;
  // restored verbatim at the end. General emphasis is left unmasked (it spans words
  // that legitimately get reworded) and relies on the prompt instruction instead.
  // `literals` are exact spans to freeze too — the bolded glossary terms (**Term**),
  // so the term text stays verbatim and keeps matching its glossary key.
  const { mask, unmask } = createMasker(literals);

  // render() shows each block to the model as "[id] text"; the model occasionally
  // echoes the marker back inside its returned text, and sequential passes would
  // then compound it. Strip only the ids minted for THIS call, so legitimate
  // bracketed spans in the content survive.
  const idMarkers = blocks.map((b) => `[${b.id}]`);
  const stripIdMarkers = (text: string): string => {
    let out = text;
    for (const m of idMarkers) {
      if (!out.includes(m)) continue;
      out = out.split(`${m} `).join("").split(m).join("");
    }
    return out.trim();
  };

  // sequential passes: each refines the prior pass's output (words → sentences →
  // paragraphs → AI patterns). A failed pass (parse/network) keeps the current
  // blocks so prior improvements survive; the loop continues.
  let cur = blocks.map((b) => ({ id: b.id, text: mask(b.text) }));
  for (const pass of passes) {
    try {
      const { blocks: rev } = await askJson<{ blocks: { id: string; text: string }[] }>(
        EXTRACT,
        revisePrompt(cur, pass),
        EXTRACT_TOKENS,
      );
      const byId = new Map(rev.map((r) => [r.id, r.text]));
      cur = cur.map((b) => {
        const t = byId.get(b.id);
        return { id: b.id, text: t != null ? stripIdMarkers(t) : b.text };
      });
    } catch (e) {
      rethrowIfBug(e, "revise");
      // a transient pass flake keeps the current blocks (see above); continue
    }
  }
  return cur.map((b) => ({ id: b.id, text: unmask(normalizeTypography(b.text)) }));
}
