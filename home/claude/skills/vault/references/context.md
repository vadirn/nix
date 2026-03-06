# Vault Context

The Obsidian vault at `~/Documents/vault` stores knowledge as interconnected markdown files.

## Folder structure

| Folder           | Content                                                              |
| ---------------- | -------------------------------------------------------------------- |
| `10 references/` | Source pointers: articles, books, videos. Raw captures, no analysis. |
| `20 cards/`      | Atomic concepts distilled from references. Your own words.           |
| `30 notes/`      | Original thinking, synthesis, how-tos. Free-form.                    |
| `31 work notes/` | Work-specific notes (same format as 30 notes/)                       |
| `41 projects/`   | Project folders with context, checkpoints, and project notes         |
| `90 bases/`      | Obsidian Bases (database views over vault content)                   |
| `templates/`     | Templates for all note types                                         |

## Schemas

- **Reference**: `type: reference`, `description`, `tags`, `reference-type` (Web/Book)
- **Card**: `type: card`, `description`, `tags`, `reference` (wikilink to source)
- **Note**: `type: note`, `description`, `tags` (optional)
- **Project**: `type: project`, `result`, `status` (in progress/done/paused)
- **Checkpoint**: `type: checkpoint`, `description`, `done`, `project`, `decisions`, `frictions`, `cost_usd`, `lines_written`, `turns_to_edit`

## Conventions

- Tags use the CLAUDE.md tag tree (Cyrillic roots like `Тема/Dev`, `Тема/Философия`)
- Wikilinks for internal connections: `[[path/to/note|Display Name]]`
- Frontmatter values with double quotes use single-quote wrapping: `description: '"Use X" does Y'`
- Card-to-card connections belong in notes, not in cards (cards stay atomic)
- References are raw captures; analysis lives in cards
