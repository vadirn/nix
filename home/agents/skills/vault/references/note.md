# Note Creation

Creates a note — original thinking, free-form.

Notes are your own ideas. They may draw on multiple cards/references but aren't direct extractions from a single source. No `reference:` backlink.

## Process

```
// Work-first gate — skip if user said "fast" or provided a clear thesis
if not fast and missing thesis:
  ask user: "What question or thesis does this note explore?"
  ask user: "Why does it matter — what does it connect or resolve?"
  wait for response
  use their framing as foundation — help structure; let the user supply the thesis

// Duplicate check — before creating anything
exact = Glob("<topic>.md", "00 inbox/") + Glob("<topic>.md", "30 notes/")
semantic = Bash(vault-query search "<topic>" -n 5)  // whole-vault, inbox included
if exact or semantic:
  present matches, ask: proceed / edit existing?

// Build the note
tags = Bash(vault-query tags --vault-root <vault_root> --sort count)  // pick one or more from this list; fall back to CLAUDE.md tag tree
// a tag absent from the list requires explicit user confirmation before use
description = 1-sentence summary of what this note explores
body = help structure thinking if requested
create file in 00 inbox/  // complete type: note; user files it to 30 notes/ once triaged

// Surface connections
related = Bash(vault-query search "<key terms>" -n 10)
present related cards/references as potential wikilink targets
```

## Frontmatter

vault_root = Bash(vault-query config).vault_root
Read(<vault_root>/templates/Note.md) for structure.

- `type` — always `note`
- `description` — 1 sentence capturing what this note explores
- `tags` — one or more from the live tag list (`vault-query tags`); a tag absent from the list requires user confirmation (optional — skip if no tag fits)

If a value contains double quotes, wrap it in single quotes: `description: '"Use X" does Y'`

## File naming

Descriptive title capturing the topic. Can be a concept, question, or how-to.

## Body

Free-form. Common patterns:

- **Design doc**: requirements, options, tradeoffs, decision
- **How-to**: step-by-step instructions
- **Exploration**: questions, observations, conclusions
- **Synthesis**: connecting ideas from multiple cards
- **Cheatsheet**: quick-reference table or list (keybindings, CLI flags, syntax)
- **Comparison**: X vs Y with tradeoffs

## Example

File: `30 notes/Dependency injection.md`

```markdown
---
type: note
description: Approaches to dependency injection in TypeScript for testability
tags: [Тема/Dev/Code]
---

Dependency injections (via a DI container) might be required to write proper tests:

- How to handle transitive dependencies / onion parameters?
- Use Proxy for dependencies?
```

## Editing existing notes

When asked to edit or enrich an existing note:

1. Read the file
2. Check what's missing: `description`, `tags`
3. Fill in missing fields. Leave existing body content unchanged.
4. If tags exist but don't match the live tag list (`vault-query tags`), suggest corrections.

## Notes

- Follow obsidian-markdown skill for Obsidian syntax
- Subdirectories for domain grouping (e.g. `30 notes/Finance/`)
- Work-specific notes go in `31 work notes/` instead
