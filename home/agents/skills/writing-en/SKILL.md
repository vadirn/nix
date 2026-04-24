---
name: writing-en
description: Writes and edits English text for clarity and concision. Removes nominalizations, passive voice, filler, and AI patterns. Use when writing documentation, README, commit messages, UI text, reports, emails, or when asked to simplify text, cut fluff, or check for plain language.
model: claude-sonnet-4-6
---

# Clear Writing in English

Sources: Orwell ("Politics and the English Language"), Williams ("Style: Lessons in Clarity and Grace"), plainlanguage.gov, RareSkills.

## Rules

Apply all rules in a single pass. Rule details are in the reference files below. Skip a rule only when applying it would change the author's meaning, lose factual precision, or violate the register of the input (e.g., do not expand terse bullet points into prose).

| Area       | Reference                                    | What it targets                                                                                |
| ---------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Words      | [pass-1-words.md](pass-1-words.md)           | Nominalizations, long words, filler, negatives, dead metaphors, formal vocabulary              |
| Sentences  | [pass-2-sentences.md](pass-2-sentences.md)   | Cohesion (known-new chain), consistent topics, actor as subject, active voice, split+reconnect |
| Paragraphs | [pass-3-paragraphs.md](pass-3-paragraphs.md) | Main point first, one topic per paragraph, informative headings, dependency order              |
| AI fixes   | [pass-4-ai.md](pass-4-ai.md)                 | Filler openings, promotional adjectives, uniform sentence length, punctuation emphasis         |
