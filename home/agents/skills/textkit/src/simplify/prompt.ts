// simplify/prompt — the Simplified-restyle ruleset and the single-pass prompt. The ruleset is a
// hand-authored TS constant, like every other textkit prompt (distill's, cards'); it is NOT read
// from Simplified.md and NOT generated. Simplified.md stays the canonical human spec and the
// agent's global OUTPUT STYLE; this constant is the single source for the RESTYLE PROMPT. They
// overlap in rule content but serve different consumers, so they are deliberately distinct.
//
// Bilingual, mirroring polish's PASS_EN/PASS_RU: the model reads English scaffolding but writes
// the restyled prose in the note's own language, anchored by the in-language ruleset — the same
// pattern revise() uses. SIMPLIFY_RULESET_RU is tailored to Russian mechanics (канцелярит,
// отглагольные существительные, «является» → тире), not a port of the English STE rules.
import { detectLang } from "textkit/core/text.ts";

// The seven brief keys the pass fills, in render order. `rewrite` carries the whole restyled note
// as one markdown string (report-brief's JSON transport); the other six are the reviewable diff.
export const BRIEF_KEYS = [
  "verdict",
  "cut",
  "change",
  "shape",
  "keep",
  "borderline",
  "rewrite",
] as const;

// One itemized edit in the `change` diff: the source span, the restyled span, the transform
// applied, and a one-clause reason. Concrete before/after (not a directive) so the human can
// check it against the rewrite and the guard can confirm each `after` appears there.
export type ChangeItem = { before: string; after: string; transform: string; why: string };

// SimplifyBrief is the seven-key object the pass returns through askJson. The six diff keys are
// human-facing; `rewrite` is the payload the subagent applies. Masked (⟦N⟧) on the way out of the
// model; the CLI unmasks before rendering. Fields are validated defensively at render time — a
// model that drops or mistypes a key must degrade to an empty section, not crash the CLI.
export type SimplifyBrief = {
  verdict: string;
  cut: string[];
  change: ChangeItem[];
  shape: string[];
  keep: string[];
  borderline: string[];
  rewrite: string;
};

// SIMPLIFY_RULESET_EN is the English rule set — the Meaning / Relevance / Sentences / Words / Shape
// principles condensed to prompt form. It drops Simplified.md's meta sections (~40% of its tokens:
// "Where it applies", "Relation to Exposition"), which a restyle model does not need and whose
// dangling cross-references would mislead it. MEANING is the fidelity governor over the restyle
// rules — a statement stays a statement, a number stays exact. Three of its claims (verb-near-
// subject, cut-restatement, keep-numbers) come from CLAUDE.md's Exposition, inlined here because
// the offline model cannot reach the Simplified.md ↔ CLAUDE.md pair the agent reads.
export const SIMPLIFY_RULESET_EN = `MEANING: restyle the wording, not the meaning. Keep each sentence's tense, mood, and polarity — a statement stays a statement, a record of what happened stays past, never a command. Use the imperative only where the source already instructs. Keep every number, name, and quoted value exactly as it stands.
RELEVANCE: lead each unit with its conclusion, then the reason. Cover only what the reader needs; cut the rest. Cut a sentence that only restates, emphasizes, or hedges; cadence earns no clause. Use the fewest words that keep the meaning whole.
SENTENCES: one idea per sentence, at most 20 words. Split a sentence that carries two claims. Use active voice and name the actor; keep the verb close to its subject. Use the imperative for an instruction ("Run X", not "You should run X"). Start with the known part, end with the new. Keep the connective — because, so, but, although — even in a short sentence.
WORDS: use one term per concept and reuse it. Prefer plain, concrete words; cut any word the sentence survives without. Replace a hidden verb with a verb ("decide", not "make a decision"). Use the positive form; state what to do. Use simple tenses. Use at most three nouns in a row.
SHAPE: turn a sequence or a set into a vertical list. Give each paragraph one topic; keep it short. Add a heading for a topic the reader may jump to.`;

// SIMPLIFY_RULESET_RU is the Russian rule set — the same five principles adapted to Russian
// mechanics, not translated from the English. СМЫСЛ mirrors EN MEANING. Tailored terms:
// канцелярит, отглагольные существительные, «является»/«представляет собой» → тире.
export const SIMPLIFY_RULESET_RU = `СМЫСЛ: меняй форму, а не смысл. Сохрани время, наклонение и полярность — утверждение остаётся утверждением, рассказ о случившемся остаётся в прошедшем времени, но не командой. Повелительное наклонение — только там, где источник уже даёт инструкцию. Каждое число, имя и цитату сохрани в точности.
ГЛАВНОЕ: вывод — первым, причина — после. Дай читателю только нужное, остальное убери. Убери предложение, которое лишь повторяет, усиливает или смягчает; красивость не даёт права на клаузу. Пиши минимумом слов без потери смысла.
ПРЕДЛОЖЕНИЯ: одна мысль — одно предложение, не длиннее 20 слов. Предложение с двумя утверждениями разбей. Активный залог, назови деятеля; держи глагол рядом с подлежащим. Для инструкции — повелительное наклонение («Запусти X», а не «Нужно запустить X»). Известное — в начало, новое — в конец. Сохрани связку — потому что, поэтому, но, хотя — даже в коротком предложении.
СЛОВА: один термин на одно понятие, повторяй его. Простые конкретные слова; убери слово, без которого предложение живёт. Отглагольное существительное → глагол («реши», а не «прими решение»); канцелярит → живой глагол. «является»/«представляет собой» → тире или прямой глагол. Утверждение вместо отрицания. Простые времена.
ФОРМА: последовательность или набор → вертикальный список. Один абзац — одна мысль, абзац короткий. Заголовок для темы, к которой читатель может перейти.`;

// The no-op clause: text already in the style must round-trip unchanged. It is the ruleset's own
// stop condition — inlined here (its one home), never in Simplified.md. Kept in the prompt so a
// compliant note is a no-op, not an over-edit.
const NO_OP =
  "If the text already satisfies every rule, change nothing: say so in `verdict`, leave `cut`, `change`, `shape`, and `borderline` empty, and reproduce the input verbatim in `rewrite`.";

// What the pass must never restyle. Structure is fixed; prose is restyled inside it. ⟦N⟧ tokens
// are frozen reference spans (wikilinks, embeds, inline code) — reproduced, never reworded.
const KEEP =
  "Keep verbatim, never restyle: headings, list and table structure, fenced code blocks, frontmatter, quoted specimens, and any fixed surface limit (a one-line commit subject, a template's sections). Reproduce every ⟦N⟧ placeholder token unchanged, exactly as many times as it appears. Keep every word in the language it is written in; never translate.";

// simplifyPrompt builds the single-pass prompt for `masked` (text with reference spans already
// frozen to ⟦N⟧). It embeds the language's ruleset, the keep-verbatim and no-op clauses, and the
// strict seven-key JSON schema, then the text. The model returns JSON; the CLI renders it to the
// markdown brief and runs the deterministic guard.
export function simplifyPrompt(masked: string, lang: "en" | "ru"): string {
  const ruleset = lang === "ru" ? SIMPLIFY_RULESET_RU : SIMPLIFY_RULESET_EN;
  return `You are an editor applying the Simplified writing style. Restyle the prose of the TEXT below to the style, and report what you changed as a strict JSON brief.

${ruleset}

${KEEP}

${NO_OP}

Return ONLY JSON with these seven keys:
{"verdict":"one sentence — does the text meet the style, and the main gap if not","cut":["each word or phrase you removed as padding"],"change":[{"before":"the original span","after":"your restyled span","transform":"split|active|de-nominalize|reorder|plain-word|list","why":"one clause"}],"shape":["each structural shift — a set turned into a vertical list, a topic heading added"],"keep":["each fixed span you preserved verbatim — a heading, a code block, a specimen"],"borderline":["each judgment call the human should check"],"rewrite":"the full restyled note as markdown, every ⟦N⟧ token reproduced unchanged"}

TEXT:
${masked}`;
}

// resolveLang picks the ruleset language: an explicit override, else detectLang on the body.
// Mirrors polish's auto/en/ru handling so the two CLIs agree on language selection.
export function resolveLang(lang: "en" | "ru" | "auto", body: string): "en" | "ru" {
  return lang === "auto" ? detectLang(body) : lang;
}
