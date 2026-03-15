# Reference Creation

Creates a reference note — a pointer to an external source (article, book, video, talk).

References are raw captures. They contain the source link and metadata, not your own analysis. Processing happens later when creating a card.

## Process

1. Ask for the source (URL, book title, etc.) if not provided
2. **Duplicate check** (before creating anything):
   - `Glob` for exact filename match in `10 references/`
   - `Bash(vault-cli search "<title>" -n 5 --files)` — near-duplicates by meaning
   - If matches found, present them and ask whether to proceed or edit existing
3. Pick `reference-type`: `Web` or `Book`. YouTube, articles, talks — all `Web`.
4. Pick tags: run `vault-query tags --vault-root <vault_root> --sort count` to get the live tag list, pick from it. Fall back to the tag tree in CLAUDE.md if vault-query is unavailable. Ask if ambiguous.
5. Write a 1-sentence `description`
6. Create the file in `10 references/`

## Frontmatter

Read `templates/Web.md` or `templates/Book.md` based on reference type.

- `type` — always `reference`
- `description` — 1 sentence describing what this source is about
- `tags` — from CLAUDE.md tag tree
- `reference-type` — `Web` or `Book`
- For Books, also: `authors`, `published`, `publisher`

If a value contains double quotes, wrap it in single quotes: `description: '"Use X" does Y'`

## File naming

Use the source title as filename. Keep the original language.

## Body

- Web: the URL on its own line
- YouTube: `![](url)` — renders as embedded player in Obsidian
- Book: `> [!Abstract]` callout with brief contents

## Example

File: `10 references/Parse, don't type-check.md`

```markdown
---
type: reference
description: Type-driven design — parsing input into well-typed structures replaces runtime type checking
tags:
  - Тема/Dev/Code
reference-type:
  - Web
---

https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/
```

## Editing existing references

When asked to edit or enrich an existing reference:

1. Read the file
2. Check what's missing: `description`, `tags`, `reference-type`
3. Fill in missing fields. Don't touch existing body content.
4. If tags exist but don't match the CLAUDE.md tag tree, suggest corrections.

## Notes

- Follow obsidian-markdown skill for Obsidian syntax
- Don't summarize the source — that's what cards are for
- When writing `description`, read the source first (use firecrawl, fallback to WebFetch). Don't guess from title alone.
