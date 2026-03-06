# Card Creation

Creates a card — a distilled atomic concept extracted from a reference source.

Cards contain your own understanding in your own words. They backlink to the source via `reference:`. One reference can produce multiple cards.

## Process

```
source = identify source reference (should exist in 10 references/)

// Duplicate check — before creating anything
exact = Glob("<concept>.md", "20 cards/")
semantic = Bash(vault-cli search "<concept>" -n 5 --files)
if exact or semantic:
  present matches, ask: proceed / merge / edit existing?

// Work-first gate — skip if user said "fast" or provided concept + description
if not fast and missing concept or description:
  ask user: "What concept would you name this card?"
  ask user: "What's the core idea in 1 sentence?"
  wait for response
  use their input as basis — refine wording, fix factual errors, don't replace

// Build the card
tags = timeout 10 obsidian tags sort=count counts  // fall back to CLAUDE.md tag tree
description = 1-sentence core idea
body = concise summary in user's own framing
create file in 20 cards/

// Surface connections
related = Bash(vault-cli search "<key terms>" -n 10 --files)
if non-trivial connection (pattern, tension, synthesis):
  propose creating a note in 30 notes/  // cards stay atomic, connections live in notes
```

## Frontmatter

Read `templates/Card.md` for structure.

- `type` — always `card`
- `description` — 1 sentence capturing the core idea
- `reference` — wikilink array to source references (e.g. `"[[10 references/Source Name|Source Name]]"`)
- `tags` — from CLAUDE.md tag tree

If a value contains double quotes, wrap it in single quotes: `description: '"Use X" does Y'`

## File naming

Name by the concept, not the source.

- 1:1 mapping: same name is fine (`Parse, don't type-check.md`)
- Multiple cards from one source: distinct name per concept
- Subdirectory for multi-part sources (e.g. `20 cards/Engineering management/`)

## Body

- 1-3 sentence summary of the concept
- Bullet points for key details
- Code snippets for technical concepts
- Keep it atomic — one idea per card
- Never add cross-card connections here; create a note instead

## Example

File: `20 cards/Impureim sandwich.md`

```markdown
---
type: card
description: Architectural pattern — sandwich pure logic between impure IO layers
reference:
  - "[[10 references/Impureim sandwich|Impureim sandwich]]"
tags: [Тема/Dev]
---

- Pure functions can't call impure actions
- But impure actions can call pure functions
- Suggested flow:
  1. Gather data from impure sources
  2. Call a pure function with that data
  3. Change state based on return value from pure function
```

## Editing existing cards

When asked to edit or enrich an existing card:

1. Read the file
2. Check what's missing: `description`, `reference:` backlink, `tags`
3. Fill in missing fields. Don't touch existing body content.
4. If tags exist but don't match the CLAUDE.md tag tree, suggest corrections.

## Notes

- Follow obsidian-markdown skill for Obsidian syntax
- If the reference doesn't exist yet, offer to create it first (reference process)
