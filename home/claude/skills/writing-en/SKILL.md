---
name: writing-en
description: Writes and edits English text for clarity and concision. Removes nominalizations, passive voice, filler, and AI patterns. Use when writing documentation, README, commit messages, UI text, reports, emails, or when asked to simplify text, cut fluff, or check for plain language.
---

# Clear Writing in English

Sources: Orwell ("Politics and the English Language"), Williams ("Style: Lessons in Clarity and Grace"), plainlanguage.gov, RareSkills.

## Passes

Run each pass as a separate subagent (clean context per pass). Each pass file contains pseudocode at the top and full rule detail below.

| Pass | File                                         | What it targets                                                                                          |
| ---- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1    | [pass-1-words.md](pass-1-words.md)           | Word-level: nominalizations, long words, filler, negatives, dead metaphors, formal vocabulary            |
| 2    | [pass-2-sentences.md](pass-2-sentences.md)   | Sentence-level: actor as subject, active voice, verb placement, familiar→new order, split+reconnect loop |
| 3    | [pass-3-paragraphs.md](pass-3-paragraphs.md) | Passage structure: main point first, one topic per paragraph, informative headings, dependency order     |
| 4    | [pass-4-ai.md](pass-4-ai.md)                 | AI pattern fixes: filler openings, promotional adjectives, uniform sentence length, punctuation emphasis |

Apply only rules that improve the text.
