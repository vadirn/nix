---
name: vault
description: >
  Personal knowledge management in an Obsidian vault. Use this skill whenever the user wants to save, find, review,
  or organize knowledge — even if they don't say "vault" or "Obsidian". Triggers on: saving a link/article/video/book
  for later (creates a reference in 10 references/), distilling a concept or takeaway from something they read/watched
  (creates a card in 20 cards/), writing down an original idea, observation, or synthesis connecting multiple concepts
  (creates a note in 30 notes/), searching or browsing what they know about a topic, quizzing or testing recall on
  saved concepts, listing or filtering cards by tag, resuming or saving progress on a project, checking project status
  or open checkpoints, reading a specific checkpoint by name or date. Also handles explicit /vault commands (search, card, note, reference, review, cards, projects,
  start, save). Do NOT use for: Obsidian app settings/UI questions, editing .base files, creating canvas files,
  general markdown editing, or web search.
---

# Vault

Universal Obsidian vault skill.

```
// vault-cli is on PATH; call it directly as `vault-cli`
dir = skill base directory

// Route by command
if "search <query>":
    results = Bash(vault-cli search <query>)
    do("present results with file paths, offer to Read top hits")

elif "card" or "card <topic>":
    Read(dir/references/card.md)
    do("follow card creation/editing process")

elif "note" or "note <topic>":
    Read(dir/references/note.md)
    do("follow note creation/editing process")

elif "reference" or "reference <topic>":
    Read(dir/references/reference.md)
    do("follow reference creation/editing process")

elif "review":
    Read(dir/references/review.md)
    do("follow review process")

elif "cards":
    results = Bash(vault-cli cards)
    Read(dir/references/cards.md)
    do("follow cards presentation process with results")

elif "notes":
    results = Bash(vault-cli notes)
    do("present notes with metadata")

elif "projects":
    results = Bash(vault-cli projects)
    do("present projects with status")

// Project commands — load context once
elif "<project> ...":
    project_context ??= Bash(vault-cli context)

    if "start":
        Read(dir/references/project-start.md)
        do("follow start procedure")
    elif "save":
        Read(dir/references/project-save.md)
        do("follow save procedure")
    else:
        do("answer using project context, checkpoints, or search as needed")

elif user mentions a note/card/reference/checkpoint by name:
    result = Bash(vault-cli get <fragment>)
    if single match: do("summarize content")
    elif multiple matches: AskUserQuestion("which one?")
    else: do("offer to search")

else:
    Bash(vault-cli config)
    do("help user with their request")
```

## Reference

### Note types

| Type       | Folder                   | Purpose                                                 |
| ---------- | ------------------------ | ------------------------------------------------------- |
| reference  | `10 references/`         | Pointer to external source. Raw capture, no analysis    |
| card       | `20 cards/`              | Distilled atomic concept from a reference               |
| note       | `30 notes/`              | Original thinking, connects ideas across sources        |
| goal       | `41 projects/`           | High-level aspiration with success criteria             |
| project    | `41 projects/<project>/` | Concrete deliverable linked to a goal                   |
| checkpoint | `41 projects/<project>/` | Session snapshot. Tracks progress, decisions, frictions |

### vault-cli subcommands

| Command                 | Description                                    | Requires config |
| ----------------------- | ---------------------------------------------- | --------------- |
| `config`                | Print resolved config JSON                     | No              |
| `context`               | Print project context.md                       | Yes             |
| `checkpoints [view]`    | Query checkpoints (All/Incomplete/Done/Stats)  | Yes             |
| `get <fragment>`        | Find and read a note/card/reference/checkpoint | No              |
| `search <query> [-n N]` | Hybrid search via qmd                          | No              |
| `update`                | Re-index and re-embed vault collection         | No              |
| `projects`              | List active projects                           | No              |
| `cards`                 | List all cards with metadata                   | No              |
| `notes`                 | List all notes with metadata                   | No              |

### Project commands

`<project> start` and `<project> save` require `.claude/.vault.config.json` in cwd. The start procedure uses `vault-cli checkpoints Incomplete` and `vault-cli checkpoints Done`. The save procedure uses `vault-cli checkpoints Incomplete`.

For generic `<project> <question>`, use `vault-cli checkpoints` or `vault-cli search <terms>` as needed.
