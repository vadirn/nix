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
import { type SequenceFinding, SEQ_MIN } from "textkit/simplify/sequence.ts";
import { type WordCapFinding, WORD_CAP } from "textkit/simplify/wordcap.ts";

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
//
// SHAPE states its member test as a GATE — two ordered halves, build only on two passes — because
// the same claims stated as a description lost to the worklist shapeHint hands over. See shapeHint's
// note for the measurement, and `fixtures/shape-member-test.md` for the two specimens it turns on.
export const SIMPLIFY_RULESET_EN = `MEANING: restyle the wording, not the meaning. Keep each sentence's tense, mood, and polarity — a statement stays a statement, a record of what happened stays past, never a command. Use the imperative only where the source already instructs. Keep every number, name, and quoted value exactly as it stands. Keep each claim's FORCE: when the source proves, requires, must, or never, say so too. Never trade a strong verb for a weaker one — "proved" stays "proved", it does not become "showed" or "found".
RELEVANCE: lead each unit with its conclusion, then the reason. Cut a sentence ONLY when it restates, emphasizes, or hedges; cadence earns no clause. Keep every sentence that carries its own claim, reason, or example, even where the passage already runs long — a reason you drop is an argument the reader loses. Use the fewest words that keep the meaning whole.
SENTENCES: one idea per sentence, at most 20 words. Split a sentence that carries two claims. Use active voice and name the actor; keep the verb close to its subject. Use the imperative for an instruction ("Run X", not "You should run X"). Start with the known part, end with the new. Keep the connective — because, so, but, although — even in a short sentence.
WORDS: use one term per concept and reuse it. Prefer plain, concrete words; cut any word the sentence survives without. Replace a hidden verb with a verb ("decide", not "make a decision"). Use the positive form; state what to do. Use simple tenses. Use at most three nouns in a row.
SHAPE: turn a PROSE sequence or set into a vertical list. A sequence is one subject governing three or more parallel actions, or three or more delimited members under one stem. Put every candidate to the member test, and build only where it passes both halves. First: the sentence carries three or more parallel members — the same part of speech in the same form. Second: the sentence enumerates rather than relates. Members enumerate when you can reorder them and the meaning holds. Parts that lose their sense when reordered stand in a relation. A contrast, a condition, a concession, or a cause and its effect is a relation, not a sequence, so keep a relation in prose. Two members is a pair, and a pair stays prose however long the sentence runs. Split a long pair into shorter sentences, never into a two-item list. Count the members in the source sentence; the list gets exactly that many items, one per member. Never invent a member to reach three, never split one member into two, never merge two into one. Where nearby prose counts the members (both, two, three), keep that word and match its count, and never add a counting word the source does not have. Keep an existing list's kind and item count as they stand; a list you build comes only from prose. Give each paragraph one topic; keep it short.`;

// SIMPLIFY_RULESET_RU is the Russian rule set — the same five principles adapted to Russian
// mechanics, not translated from the English. СМЫСЛ mirrors EN MEANING. Tailored terms:
// канцелярит, отглагольные существительные, «является»/«представляет собой» → тире.
export const SIMPLIFY_RULESET_RU = `СМЫСЛ: меняй форму, а не смысл. Сохрани время, наклонение и полярность — утверждение остаётся утверждением, рассказ о случившемся остаётся в прошедшем времени, но не командой. Повелительное наклонение — только там, где источник уже даёт инструкцию. Каждое число, имя и цитату сохрани в точности. Сохрани СИЛУ каждого утверждения: если источник доказывает, требует, обязывает или запрещает — говори так же. Не меняй сильный глагол на слабый: «доказал» остаётся «доказал» и не превращается в «показал».
ГЛАВНОЕ: вывод — первым, причина — после. Убирай предложение, ТОЛЬКО если оно повторяет, усиливает или смягчает; красивость не даёт права на клаузу. Сохрани каждое предложение со своим утверждением, доводом или примером, даже если отрывок и так длинный — выброшенный довод читатель теряет навсегда. Пиши минимумом слов без потери смысла.
ПРЕДЛОЖЕНИЯ: одна мысль — одно предложение, не длиннее 20 слов. Предложение с двумя утверждениями разбей. Активный залог, назови деятеля; держи глагол рядом с подлежащим. Для инструкции — повелительное наклонение («Запусти X», а не «Нужно запустить X»). Известное — в начало, новое — в конец. Сохрани связку — потому что, поэтому, но, хотя — даже в коротком предложении.
СЛОВА: один термин на одно понятие, повторяй его. Простые конкретные слова; убери слово, без которого предложение живёт. Отглагольное существительное → глагол («реши», а не «прими решение»); канцелярит → живой глагол. «является»/«представляет собой» → тире или прямой глагол. Утверждение вместо отрицания. Простые времена.
ФОРМА: последовательность или набор В ПРОЗЕ → вертикальный список. Последовательность — это одно подлежащее с тремя и более параллельными действиями либо три и более однородных члена при одной основе. Проверь каждого кандидата тестом на члены и строй список, только если он прошёл обе половины. Первое: предложение несёт три и более параллельных члена — одна часть речи в одной форме. Второе: предложение перечисляет, а не связывает. Члены перечисляют, если их можно переставить местами и смысл сохранится. Части, которые при перестановке теряют смысл, стоят в отношении. Противопоставление, условие, уступка, причина со следствием — это отношение, а не перечисление, поэтому отношение оставь прозой. Два члена — это пара, а пара остаётся прозой, какой бы длинной ни была фраза. Длинную пару разбей на короткие предложения, а не на список из двух пунктов. Посчитай члены в исходном предложении: в списке ровно столько пунктов, по одному на член. Не придумывай член ради третьего пункта, не дроби один член надвое, не сливай два в один. Если рядом в тексте назван счёт (оба, два, три), сохрани это слово и совпади с ним, и не добавляй счёт, которого в источнике нет. У существующего списка сохрани вид и число пунктов как есть; новый список строится только из прозы. Один абзац — одна мысль, абзац короткий.`;

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
// cap the rule itself enforces, and a denser instruction is likelier to be misread.
//
// Its scope is now explicit, because the unscoped form killed SHAPE outright. KEEP used to end that
// clause with a bare "Never promote a sentence to a new list item". It was meant to bound the
// existing list in front of it, and it did not read that way — it sat among unqualified absolutes
// ("Keep the heading count exact", "Never promote a bold lead … to a heading"), so the model took it
// as a flat ban and SHAPE built nothing. A live pass on a four-verb sentence returned four sentences
// tagged `split` with `## Shape` empty. guard.ts had assumed the opposite all along: its list axis
// forgives a grown item count precisely because "the SHAPE rule inflates a list on purpose". The
// prohibition is now tied to the list it governs, and KEEP names SHAPE's remaining territory —
// prose outside any list — so the two rules no longer contradict.
//
// That restated territory now restates the whole member test, not half of it. KEEP used to hand
// SHAPE "three or more parallel members" and stop there, which is the count without the kind — and
// the count alone is what a relation passes. Both halves ride here now, plus the pair floor, so a
// reader of KEEP alone reaches the same verdict as a reader of SHAPE.
//
// The heading clause is load-bearing too: dogfooding on PR bodies showed the model inflating bold
// list-leads into headings and sectioning off a rhetorical-question paragraph (two headings became
// six), so KEEP fixes the heading count and forbids promotion while SHAPE no longer invites adding
// one. ⟦N⟧ tokens are frozen verbatim spans (wikilinks, embeds, inline code, HTML comments) —
// reproduced, never reworded. KEEP needs no clause naming any of them: masking makes each one
// opaque, so the ruleset's existing "reproduce every ⟦N⟧ token unchanged" already covers a comment,
// and a stated rule the model may or may not obey never enters the picture.
const KEEP =
  "Keep verbatim, never restyle: headings, table structure, fenced code blocks, frontmatter, thematic breaks (a `---` separator line), quoted specimens, and any fixed surface limit (a one-line commit subject, a template's sections). For an existing list, keep its kind (numbered stays numbered, bulleted stays bulleted) and its item count. Restyle the prose inside each item. Split a long sentence into shorter sentences within the same item, and never grow that list's item count. A sentence inside a list item stays prose, so never nest a new list under one. SHAPE still governs prose OUTSIDE any list: build a vertical list there only where the sentence carries three or more parallel members that enumerate rather than relate. Two members is a pair, and a pair stays prose. Keep the heading count exact. Never promote a bold lead, a question, or a sentence to a heading. Reproduce every ⟦N⟧ placeholder token unchanged, exactly as many times as it appears. Keep every word in the language it is written in; never translate.";

// capHint is the deterministic length pre-hint: wordCapScan measures the SOURCE before the pass and
// names each prose sentence over the cap. The ruleset already states the cap, yet the model counts
// words unreliably — a live no-op left three sentences over it while reporting the note compliant —
// so handing the model the measured offenders turns the rule into a checklist. Framed as CANDIDATES,
// not commands: a legitimately long sentence (an em-dash aside, a quoted line) is kept and flagged in
// `borderline`, never force-split. Empty when the source is within the cap, so a clean note gets no
// hint and the no-op clause governs alone.
export function capHint(overCap: WordCapFinding[], lang: "en" | "ru"): string {
  if (overCap.length === 0) return "";
  if (lang === "ru") {
    const list = overCap.map((f) => `- (${f.words} сл.) ${f.sentence}`).join("\n");
    return `ПРОВЕРКА ДЛИНЫ: детерминированная проверка нашла эти предложения источника длиннее ${WORD_CAP} слов. Разбей каждое там, где разбивка сохраняет смысл. Если предложение нельзя разбить без искажения — оставь его как есть и отметь в «borderline»:\n${list}`;
  }
  const list = overCap.map((f) => `- (${f.words} words) ${f.sentence}`).join("\n");
  return `LENGTH CHECK: a deterministic scan found these source sentences over the ${WORD_CAP}-word cap. Split each where a split preserves the meaning. If a sentence cannot split without distorting it, keep it and note it in \`borderline\`:\n${list}`;
}

// shapeHint is the deterministic SHAPE pre-hint, capHint's sibling: sequenceScan measures the SOURCE
// before the pass and names each prose sentence enumerating three or more members. It exists for the
// same reason capHint does — a rule the ruleset merely states loses to a rule that arrives as a
// measured worklist. SENTENCES had capHint and SHAPE had nothing, so a four-verb sentence came back
// as four sentences tagged `split` with `## Shape` reporting "None".
//
// Framed as CANDIDATES, not commands, and the escape hatch matters more here than for length. An
// over-cap sentence is always a miss, but a sequence left as prose is often right: the enumeration
// may already appear nearby in another notation (a diagram, a table), which is context this scan
// cannot see. So a declined candidate goes to `borderline` with its reason, and that note is the
// receipt. No guard axis watches DECLINES, for that reason: a legitimate decline would show up as a
// permanent finding with no way to acknowledge it.
//
// The guard's list axis runs the opposite direction — it measures what the rewrite ADDED, never what
// it declined — so that objection does not reach it. A candidate left as prose produces no finding
// there at all. See guard.ts for the axis and the measurements that scoped it.
//
// Unlike capHint the hint ALWAYS rides. An absent length finding means nothing to split, but shape
// silence means the opposite: it leaves SHAPE an unbounded principle, which is exactly when it
// over-fires. It rides for an observed failure — across thirteen restyled notes SHAPE did not merely
// fire, it MANUFACTURED. It padded a two-consequence passage to a third invented bullet, split a
// benefit/cost pair into flat siblings, left "both facts" and "Both sides" pointing at three and four
// items, and followed "the Destination fixes two things" with three. One split replicated a masked
// ⟦N⟧ span three times and hard-blocked the apply gate.
//
// The worklist is a FLOOR, not a boundary, and that reverses the first fix for the above. The
// worklist was closed outright — "convert no other sentence, however list-like it reads" — which did
// stop the manufacturing and cost Russian everything: Russian writes «А, Б и В» with no comma before
// "и", so no Russian comma series is ever confirmed, and against zero findings the closed form banned
// the rule wholesale. Reopening is safe because the RULESET now carries what the ban stood in for —
// count the members, never invent one, a relation is not a sequence, match a stated count. Measured
// against the closed form: on a trap-dense English fixture over four runs the open hint converted the
// one real series every time and left every pair as prose, and on a Russian note it converted a
// genuine three-member series the closed form had suppressed.
//
// Reopening then exposed the defect this hint's current wording answers: the worklist read as a
// LICENCE. It said "The scan confirmed these sentences, so turn each into a vertical list, one item
// per source member" — an imperative carrying a count — while the relation carve-out sat back in the
// preamble. So a confirmed candidate that was actually a relation got converted, and the model
// back-filled members to reach the count it had been handed.
//
// That is a measured cause, not a reading. The fixture `fixtures/shape-member-test.md` holds two
// sentences the scan confirms at 3 members each and cannot tell apart: "Build the DSL outward from
// the operations that consume it, not top-down as a taxonomy, or it becomes ornament" (a contrast
// plus its consequence — a relation) and "The scan strips fenced code, skips every list item, and
// measures both delimiters" (a real series). One factor differs between them, and it is the member
// test. On the old wording the relation was flattened into three bullets in 2 of 3 live runs, once
// under an invented lead "Build the DSL in three ways:"; the series converted in 3 of 3. On this
// wording the relation stayed prose in 3 of 3 and the series still converted in 3 of 3.
//
// The fix is therefore placed where the licence was issued, not only where the rule is stated. The
// hint now says outright that the scan counts DELIMITERS and cannot tell a member from a contrast or
// a consequence, and its worklist branch hands over candidates to be tested rather than sentences to
// be converted — "a confirmed count is no licence". The floor is untouched: a candidate that fails
// the test goes to prose, never to a ban on the sentences the scan never saw.
//
// The pair clause rides here for the second specimen, whose defect is an INTERACTION. A 40-word
// sentence naming two deferred strands drew a capHint "split this" and the model reached for a list
// to split into, twice in one note. Naming where a long pair's split lands — in shorter sentences —
// closes the gap between the two hints, which neither hint could close alone.
//
// Both languages take the same wording, deliberately. The scan reaches Russian less far, but that is
// a fact about Russian punctuation, so it belongs in what the scan CONFIRMS — never in what the two
// contracts permit. A per-language ban would make the tool behave differently by language, which is
// a divergence no source asked for.
export function shapeHint(sequences: SequenceFinding[], lang: "en" | "ru"): string {
  if (lang === "ru") {
    const base =
      "ПРОВЕРКА ФОРМЫ: детерминированная проверка измерила источник. Она читает только две формы: ряд, закрытый на «, и»/«, или», и набор через точку с запятой. Все прочие формы ей не видны, поэтому её итог — нижняя граница, а не предел. Проверка считает разделители, поэтому она не отличит член от противопоставления или следствия — это читаешь ты. Строй список только там, где предложение прошло тест на члены: три и более грамматически параллельных члена — одна часть речи в одной форме — и перечисление, а не связь. Члены перечисляют, если их можно переставить местами и смысл сохранится. Противопоставление, условие, уступка, причина со следствием — это отношение, поэтому оставь его прозой. Два члена — это пара, и пара остаётся прозой, даже когда предложение длинное: разбей его на короткие предложения, а не на список из двух пунктов. Не придумывай член ради третьего пункта и не дроби один член надвое.";
    if (sequences.length === 0)
      return `${base} Проверка не подтвердила ни одного такого предложения. Каждый построенный список отметь в «borderline» с причиной.`;
    const list = sequences.map((f) => `- (${f.members} чл.) ${f.sentence}`).join("\n");
    return `${base} Эти предложения проверка подтвердила как кандидатов, поэтому каждого прогони через тест на члены, прежде чем строить. Прошедший кандидат становится вертикальным списком: один пункт на один член источника. Не прошедший остаётся прозой — проверка этой разницы не видит, и подтверждённый счёт права не даёт. Число — это измерение, и оно завышено, когда последний член сам является перечислением, поэтому пересчитай перед тем, как строить. Оставь подтверждённое предложение прозой, если перечисление уже дано рядом другой записью, если предложение стоит внутри пункта списка или если список повторил бы токен ⟦N⟧. Каждый построенный список и каждое оставленное предложение отметь в «borderline» с причиной:\n${list}`;
  }
  const base = `SHAPE CHECK: a deterministic scan measured the source. It reads two forms only: a series closing on ", and"/", or", and a semicolon set. Every other form is invisible to it, so its result is a floor, not a boundary. The scan counts delimiters, so it cannot tell a member from a contrast or a consequence — that reading is yours. Build a list only where the sentence passes the member test: ${SEQ_MIN} or more grammatically parallel members — the same part of speech in the same form — enumerating rather than relating. Members enumerate when you can reorder them and the meaning holds. A contrast, a condition, a concession, or a cause and its effect is a relation, so keep it prose. Two members is a pair, and a pair stays prose even when the sentence runs long: split it into shorter sentences, never into a two-item list. Never invent a member to reach three, and never split one member into two.`;
  if (sequences.length === 0)
    return `${base} The scan confirmed no such sentence. Note each list you build in \`borderline\` with the reason.`;
  const list = sequences.map((f) => `- (${f.members} members) ${f.sentence}`).join("\n");
  return `${base} The scan confirmed these sentences as candidates, so put each to the member test before you build. A candidate that passes becomes a vertical list, one item per source member. A candidate that fails stays prose — the scan cannot see the difference, and a confirmed count is no licence. The count is a measurement, and it runs high when the last member is itself a series, so recount before you build. Keep a confirmed sentence as prose when the enumeration already appears nearby in another notation, when it sits inside a list item, or when a list would repeat a ⟦N⟧ token. Note each list you build and each confirmed sentence you keep in \`borderline\` with the reason:\n${list}`;
}

// simplifyPrompt builds the single-pass prompt for `masked` (text with reference spans already
// frozen to ⟦N⟧). It embeds the language's ruleset, the keep-verbatim and no-op clauses, the two
// deterministic pre-hints, and the strict seven-key JSON schema, then the text. The model returns
// JSON; the CLI renders it to the markdown brief and runs the deterministic guard.
//
// The hints are not symmetric. capHint rides only when the source has an over-cap sentence, while
// shapeHint always rides — with a worklist when the scan found sequences, and with an explicit
// "build no new list" when it found none. So `sequences` defaulting to `[]` reads as "the scan ran
// and found nothing", which is a suppression, not an omission. Every real caller runs sequenceScan
// and passes its result.
export function simplifyPrompt(
  masked: string,
  lang: "en" | "ru",
  overCap: WordCapFinding[] = [],
  sequences: SequenceFinding[] = [],
): string {
  const ruleset = lang === "ru" ? SIMPLIFY_RULESET_RU : SIMPLIFY_RULESET_EN;
  const hints = [capHint(overCap, lang), shapeHint(sequences, lang)].filter(Boolean);
  return `You are an editor applying the Simplified writing style. Restyle the prose of the TEXT below to the style, and report what you changed as a strict JSON brief.

${ruleset}

${KEEP}

${NO_OP}${hints.length ? `\n\n${hints.join("\n\n")}` : ""}

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
