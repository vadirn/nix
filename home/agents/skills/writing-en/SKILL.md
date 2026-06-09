---
name: writing-en
description: Edit English text for clarity. Removes passive voice, filler, AI patterns. Use on /writing-en, "simplify text", "cut fluff". For flipping negative instructions to positive directives in skill files or prompts, use /affirm.
---

# Clear Writing in English

Sources: Orwell ("Politics and the English Language"), Williams ("Style: Lessons in Clarity and Grace"), plainlanguage.gov, RareSkills.

## Rules

Apply all rules in a single reading. Rule details are in the reference files below. Skip a rule only when applying it would change the author's meaning, lose factual precision, or violate the register of the input (e.g., do not expand terse bullet points into prose). Exception: pass-2's split-and-reconnect step runs as an iterative loop until the text is stable, not once.

| Area       | Reference                                    | What it targets                                                                                                                                           |
| ---------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Words      | [pass-1-words.md](pass-1-words.md)           | Nominalizations, long words, filler, negatives, dead metaphors, formal vocabulary                                                                         |
| Sentences  | [pass-2-sentences.md](pass-2-sentences.md)   | Cohesion (known-new chain), consistent topics, actor as subject, active voice, split+reconnect                                                            |
| Paragraphs | [pass-3-paragraphs.md](pass-3-paragraphs.md) | Main point first, one topic per paragraph, informative headings, dependency order                                                                         |
| AI fixes   | [pass-4-ai.md](pass-4-ai.md)                 | Filler openings, promotional adjectives, significance inflation, plain copulas, canned constructions, AI vocabulary, uniform sentence length, punctuation |
