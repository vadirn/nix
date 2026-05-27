---
name: logic-check
description: >
  Проверка текста на логические ошибки по Виноградову/Кузьмину: законы логики, правила доказательства,
  определения и деления. Use to check reasoning, find fallacies, audit an argument. Triggers:
  /logic-check, "проверь логику", "check the reasoning". Output language matches input (RU/EN).
model: claude-opus-4-7
---

# Проверка логики / Logic check

Источник правил: «Логика, учебник для средней школы» (Виноградов, Кузьмин, УЧПЕДГИЗ, 1954).

## Parameters

- `text` (required): Текст для проверки. Inline в аргументах, путь к файлу, или взят из контекста разговора. Russian or English.

## Процедура

```
text = parse text from arguments or conversation context
if text is a file path: text = Read(<path>)
if no text provided: AskUserQuestion("какой текст или файл проверить? / which text or file to check?"), then stop

// Detect output language
lang = do("detect language of text: 'ru' if Russian, 'en' if English; default to language of text, not of the request")

// Load rules (parallel) — references are in Russian; the model applies them to text in any language
Read(references/laws.md)
Read(references/proof.md)
Read(references/definition-division.md)
Read(references/forms.md)

// Reconstruct argument
thesis, premises, conclusion = do("extract thesis, premises, and conclusion from text")
if structure was implicit: do("show reconstruction to user before listing violations")

// Fix term meanings
terms = do("list key terms; for each multivalent term, note the sense it carries in each location")

// Scan for violations
violations = do("walk text against each loaded reference; record only real violations, not stylistic weaknesses")

// Output — match the input language
if violations is empty:
    do("emit report in <lang> with Reconstruction + Overall assessment, state argument is logically sound")
else:
    do("emit full report in <lang> following the template for that language in Reference; use rule names from the bilingual glossary")
```

## Reference

### Areas of check

| Область / Area                | Файл правил                       | Что ищем / What to look for                                                                       |
| ----------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------- |
| Четыре закона логики          | references/laws.md                | Подмена смысла термина, противоречие, ложная дилемма / уход от выбора, утверждения без основания  |
| Шесть правил доказательства   | references/proof.md               | Размытый/подменённый тезис, ложные/недостаточные доводы, порочный круг, нелогичный вывод          |
| Определения и деления         | references/definition-division.md | Несоразмерные определения, круг, отрицательные определения, скачки в делении                      |
| Формы мысли и статус суждений | references/forms.md               | Гипотеза, поданная как доказанное; смешение понятия, суждения и умозаключения; неверное обращение |

### Report template — Russian

```markdown
## Реконструкция аргумента

**Тезис:** <одно суждение>
**Доводы:**

1. <довод 1>
2. <довод 2>
   **Вывод:** <если отличается от тезиса>

## Нарушения

### 1. <Название правила или закона>

**Цитата:** «<точная цитата из текста>»
**Что нарушено:** <короткое объяснение, ссылка на правило>
**Почему это проблема:** <следствие для аргумента — какой шаг рассуждения теряет силу>
**Что можно сделать:** <конкретная правка или вопрос, который снимает проблему>

### 2. <...>

## Общая оценка

<1-2 предложения: держится ли аргумент в целом, какое нарушение принципиальное (если есть)>
```

Если нарушений нет — пропусти секцию «Нарушения», в общей оценке скажи: «Аргумент логически корректен по проверенным правилам».

### Report template — English

```markdown
## Argument reconstruction

**Thesis:** <one proposition>
**Premises:**

1. <premise 1>
2. <premise 2>
   **Conclusion:** <if it differs from the thesis>

## Violations

### 1. <Name of the rule or law>

**Quote:** "<exact quote from the text>"
**What is violated:** <short explanation, reference to the rule>
**Why it is a problem:** <consequence for the argument — which step loses force>
**What to do:** <a concrete edit or question that resolves the problem>

### 2. <...>

## Overall assessment

<1-2 sentences: does the argument hold overall, which violation is principal (if any)>
```

If no violations — skip the Violations section, in the overall assessment say: "The argument is logically sound by the rules checked."

### Bilingual glossary of rule names

Use these names when emitting the report. Pick the column that matches the output language.

| Russian (источник)                     | English (output)                            |
| -------------------------------------- | ------------------------------------------- |
| Закон тождества                        | Law of identity                             |
| Закон противоречия                     | Law of non-contradiction                    |
| Закон исключённого третьего            | Law of excluded middle                      |
| Закон достаточного основания           | Law of sufficient reason                    |
| Подмена понятия                        | Equivocation                                |
| Подмена тезиса                         | Shifting the thesis (ignoratio elenchi)     |
| Ad hominem                             | Ad hominem                                  |
| Основное заблуждение                   | False premise                               |
| Не вытекает / не следует               | Non sequitur                                |
| От относительного к безотносительному  | Fallacy of accident (a dicto secundum quid) |
| Порочный круг                          | Circular reasoning (begging the question)   |
| Учетверение терминов                   | Four terms (quaternio terminorum)           |
| Поспешное обобщение                    | Hasty generalisation                        |
| После этого — значит, по причине этого | Post hoc ergo propter hoc                   |
| Ложная дилемма                         | False dilemma                               |
| Правило соразмерности определения      | Rule of proportionality (definition)        |
| Круг в определении                     | Circular definition                         |
| Отрицательное определение              | Negative definition                         |
| Правило соразмерности деления          | Rule of exhaustiveness (division)           |
| Деление по разным основаниям           | Cross-division                              |
| Скачок в делении                       | Skip in division                            |
| Гипотеза vs доказанное                 | Hypothesis vs proven claim                  |
| Доказательство                         | Proof                                       |
| Неправомерное обращение                | Illicit conversion                          |

### Что не считать нарушением / What not to flag

- **Несогласие ≠ нарушение логики / Disagreement ≠ logical error.** Тезис «небо зелёное» не нарушает логику — он нарушает факты. Если довод не имеет реального основания, называй это нарушением закона достаточного основания, а не «тезис ложный». A claim like "the sky is green" does not break logic — it breaks the facts. If a premise lacks real grounding, call it a violation of the law of sufficient reason, not "the thesis is false".
- **Помеченная гипотеза / Hedged hypothesis.** «Возможно, X» / "Possibly X" — корректное суждение возможности. Ошибка только когда гипотеза подаётся как доказанный факт без оснований.
- **Жанр текста / Genre of the text.** Краткая заметка не обязана нести полное доказательство. A short note is not a treatise — do not demand proof the author never claimed to provide.
- **Стиль ≠ логика / Style ≠ logic.** Тяжёлый язык, повторы, канцеляризмы — не задача скилла. Heavy prose, repetition, jargon — not the skill's job. If the text is logically sound but poorly written, say so in one line and do not bloat the report.

### Цитирование правил / Citing rules

Отсылай к правилу по имени из глоссария выше. Дословные формулировки лежат в references/ — читай их, в отчёт переноси только суть.

Refer to rules by name from the glossary above. Verbatim formulations live in references/ — read them, but in the report carry only the essence.
