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
export const SIMPLIFY_RULESET_EN = `MEANING: restyle the wording, not the meaning. Keep each sentence's tense, mood, and polarity — a statement stays a statement, a record of what happened stays past, never a command. Use the imperative only where the source already instructs. Keep every number, name, and quoted value exactly as it stands. Keep each claim's FORCE: when the source proves, requires, must, or never, say so too. Never trade a strong verb for a weaker one — "proved" stays "proved", it does not become "showed" or "found".
RELEVANCE: lead each unit with its conclusion, then the reason. Cut a sentence ONLY when it restates, emphasizes, or hedges; cadence earns no clause. Keep every sentence that carries its own claim, reason, or example, even where the passage already runs long — a reason you drop is an argument the reader loses. Use the fewest words that keep the meaning whole.
SENTENCES: one idea per sentence, at most 20 words. Split a sentence that carries two claims. Use active voice and name the actor; keep the verb close to its subject. Use the imperative for an instruction ("Run X", not "You should run X"). Start with the known part, end with the new. Keep the connective — because, so, but, although — even in a short sentence.
WORDS: use one term per concept and reuse it. Prefer plain, concrete words; cut any word the sentence survives without. Replace a hidden verb with a verb ("decide", not "make a decision"). Use the positive form; state what to do. Use simple tenses. Use at most three nouns in a row.
SHAPE: turn a PROSE sequence or set into a vertical list; keep an existing list's kind and item count as they stand. Give each paragraph one topic; keep it short.`;

// SIMPLIFY_RULESET_RU is the Russian rule set — the same five principles adapted to Russian
// mechanics, not translated from the English. СМЫСЛ mirrors EN MEANING. Tailored terms:
// канцелярит, отглагольные существительные, «является»/«представляет собой» → тире.
export const SIMPLIFY_RULESET_RU = `СМЫСЛ: меняй форму, а не смысл. Сохрани время, наклонение и полярность — утверждение остаётся утверждением, рассказ о случившемся остаётся в прошедшем времени, но не командой. Повелительное наклонение — только там, где источник уже даёт инструкцию. Каждое число, имя и цитату сохрани в точности. Сохрани СИЛУ каждого утверждения: если источник доказывает, требует, обязывает или запрещает — говори так же. Не меняй сильный глагол на слабый: «доказал» остаётся «доказал» и не превращается в «показал».
ГЛАВНОЕ: вывод — первым, причина — после. Убирай предложение, ТОЛЬКО если оно повторяет, усиливает или смягчает; красивость не даёт права на клаузу. Сохрани каждое предложение со своим утверждением, доводом или примером, даже если отрывок и так длинный — выброшенный довод читатель теряет навсегда. Пиши минимумом слов без потери смысла.
ПРЕДЛОЖЕНИЯ: одна мысль — одно предложение, не длиннее 20 слов. Предложение с двумя утверждениями разбей. Активный залог, назови деятеля; держи глагол рядом с подлежащим. Для инструкции — повелительное наклонение («Запусти X», а не «Нужно запустить X»). Известное — в начало, новое — в конец. Сохрани связку — потому что, поэтому, но, хотя — даже в коротком предложении.
СЛОВА: один термин на одно понятие, повторяй его. Простые конкретные слова; убери слово, без которого предложение живёт. Отглагольное существительное → глагол («реши», а не «прими решение»); канцелярит → живой глагол. «является»/«представляет собой» → тире или прямой глагол. Утверждение вместо отрицания. Простые времена.
ФОРМА: последовательность или набор В ПРОЗЕ → вертикальный список; у существующего списка сохрани вид и число пунктов как есть. Один абзац — одна мысль, абзац короткий.`;

// The no-op clause: text already in the style must round-trip unchanged. It is the ruleset's own
// stop condition — inlined here (its one home), never in Simplified.md. Kept in the prompt so a
// compliant note is a no-op, not an over-edit.
const NO_OP =
  "If the text already satisfies every rule, change nothing: say so in `verdict`, leave `cut`, `change`, `shape`, and `borderline` empty, and reproduce the input verbatim in `rewrite`.";

// What the pass must never restyle. Structure is fixed; prose is restyled inside it. The list
// clause is load-bearing: the model was observed to over-split a list (three numbered items became
// sixteen bullets), so KEEP names list kind, item count, and split-within-item explicitly — the
// SHAPE rule builds a list only from prose. That clause is four short sentences, one idea each, not
// one 45-word run-on: dogfooding simplify-text on this prompt flagged the run-on over the 20-word
// cap the rule itself enforces, and a denser instruction is likelier to be misread. The heading
// clause is load-bearing too: dogfooding on PR bodies showed the model inflating bold list-leads
// into headings and sectioning off a rhetorical-question paragraph (two headings became six), so
// KEEP fixes the heading count and forbids promotion while SHAPE no longer invites adding one.
// ⟦N⟧ tokens are frozen reference spans (wikilinks, embeds, inline code) — reproduced, never
// reworded.
const KEEP =
  "Keep verbatim, never restyle: headings, table structure, fenced code blocks, frontmatter, thematic breaks (a `---` separator line), quoted specimens, and any fixed surface limit (a one-line commit subject, a template's sections). For an existing list, keep its kind (numbered stays numbered, bulleted stays bulleted) and its item count. Restyle the prose inside each item. Split a long sentence into shorter sentences within the same item. Never promote a sentence to a new list item. Keep the heading count exact. Never promote a bold lead, a question, or a sentence to a heading. Reproduce every ⟦N⟧ placeholder token unchanged, exactly as many times as it appears. Keep every word in the language it is written in; never translate.";

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
{"verdict":"one sentence — does the text meet the style, and the main gap if not","cut":["each word or phrase you removed as padding"],"change":[{"before":"the original span","after":"your restyled span","transform":"split|active|de-nominalize|reorder|plain-word|list","why":"one clause"}],"shape":["each structural shift — a prose set turned into a vertical list"],"keep":["each fixed span you preserved verbatim — a heading, a code block, a specimen"],"borderline":["each judgment call the human should check"],"rewrite":"the full restyled note as markdown, every ⟦N⟧ token reproduced unchanged"}

TEXT:
${masked}`;
}

// resolveLang picks the ruleset language: an explicit override, else detectLang on the body.
// Mirrors polish's auto/en/ru handling so the two CLIs agree on language selection.
export function resolveLang(lang: "en" | "ru" | "auto", body: string): "en" | "ru" {
  return lang === "auto" ? detectLang(body) : lang;
}
