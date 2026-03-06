---
name: vault
description: >
  Universal Obsidian vault skill. Handles search, cards, notes, references, review, projects, and per-project sessions.
  Use for: /vault search, /vault card, /vault note, /vault reference, /vault review, /vault cards, /vault projects,
  /vault <project> start, /vault <project> save, /vault <project> <question>.
  Also triggers on: find in vault, search notes, list cards, create card, create note, create reference,
  review cards, project status, checkpoint, save session, resume session.
---

# Vault

Universal Obsidian vault skill.

## Note types

- **reference** — pointer to external source (article, book, video). Raw capture, no analysis. → `10 references/`
- **card** — distilled atomic concept extracted from a reference. Your understanding in your words. → `20 cards/`
- **note** — original thinking, free-form. Connects ideas, not tied to a single source. → `30 notes/`
- **goal** — high-level aspiration with success criteria and plans. → `41 projects/`
- **project** — concrete deliverable linked to a goal. Has status, deadline, checkpoints. → `41 projects/<project>/`
- **checkpoint** — session snapshot for a project. Tracks progress, decisions, frictions. → `41 projects/<project>/`

```
dir = directory containing this file
cli = dir + "/scripts/vault-cli"

// Parse command: first word after /vault
command = user's command after /vault

if command starts with "search ":
    query = everything after "search "
    results = Bash(cli search <query>)
    present results with file paths
    offer to Read top hits

elif command == "card" or command starts with "card ":
    Read(dir/references/card.md)
    follow card creation/editing process

elif command == "note" or command starts with "note ":
    Read(dir/references/note.md)
    follow note creation/editing process

elif command == "reference" or command starts with "reference ":
    Read(dir/references/reference.md)
    follow reference creation/editing process

elif command == "review":
    Read(dir/references/review.md)
    follow review process

elif command == "cards" or command starts with "cards ":
    results = Bash(cli cards)
    Read(dir/references/cards.md)
    follow cards presentation process with results

elif command == "projects":
    results = Bash(cli projects)
    present results with status

elif command matches "<project> start":
    project_context = Bash(cli context)  // needs .vault.config.json in cwd
    Read(dir/references/project-start.md)
    follow start procedure
    // use: Bash(cli checkpoints Incomplete) and Bash(cli checkpoints Done)

elif command matches "<project> save":
    project_context = Bash(cli context)
    Read(dir/references/project-save.md)
    follow save procedure
    // use: Bash(cli checkpoints Incomplete) for queries

elif command matches "<project> ...":
    project_context = Bash(cli context)
    answer using project context
    // if question involves checkpoints: Bash(cli checkpoints)
    // if question involves search: Bash(cli search <terms>)

else:
    // Generic vault question — use search + context
    Bash(cli config)  // show what's available
    help user with their request
```

## vault-cli reference

The CLI script lives at `dir/scripts/vault-cli`. Subcommands:

| Command                 | Description                                   | Requires config |
| ----------------------- | --------------------------------------------- | --------------- |
| `config`                | Print resolved config JSON                    | No              |
| `context`               | Print project context.md                      | Yes             |
| `checkpoints [view]`    | Query checkpoints (All/Incomplete/Done/Stats) | Yes             |
| `search <query> [-n N]` | Hybrid search via qmd                         | No              |
| `update`                | Re-index and re-embed vault collection        | No              |
| `projects`              | List active projects                          | No              |
| `cards`                 | List all cards with metadata                  | No              |
