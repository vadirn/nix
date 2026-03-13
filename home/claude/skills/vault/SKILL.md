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
  start, save). XP/streak reports are CLI-only (vault-cli xp), not routed through the skill. Do NOT use for: Obsidian app settings/UI questions, editing .base files, creating canvas files,
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
    project_context ??= Bash(vault-cli --project <project> context)

    if "start":
        Read(dir/references/project-start.md)
        do("follow start procedure")
    elif "save":
        Read(dir/references/project-save.md)
        do("follow save procedure")
    else:
        do("answer using project context, checkpoints, or search as needed")

elif "log" or weekly log intent (planning, tasks, sleep):
    Read(dir/references/log-weekly.md)
    week_file = Bash(vault-cli log)
    log = Read(week_file)
    do("show current week's log, ask what user wants to do")

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

| Type       | Folder                      | Purpose                                                 |
| ---------- | --------------------------- | ------------------------------------------------------- |
| reference  | `10 references/`            | Pointer to external source. Raw capture, no analysis    |
| card       | `20 cards/`                 | Distilled atomic concept from a reference               |
| note       | `30 notes/`                 | Original thinking, connects ideas across sources        |
| goal       | `41 projects/`              | High-level aspiration with success criteria             |
| project    | `41 projects/<project>/`    | Concrete deliverable linked to a goal                   |
| checkpoint | `41 projects/<project>/`    | Session snapshot. Tracks progress, decisions, frictions |
| weekly-log | `41 projects/block-buster/` | Weekly plan/tasks/activity log for gamified tracking    |

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
| `log [DATE\|WEEK\|last\|next]` | Open or create weekly log                 | No              |

### Project commands

`<project> start` and `<project> save` resolve the project via `--project <name>` flag, which uses the root config (`~/.claude/.vault.config.json`) to find `{vault_root}/{projects_path}/<name>`. This works from any directory. If called from a repo with `.claude/.vault.config.json`, the local project config takes precedence unless `--project` is given.

The start procedure uses `vault-cli --project <name> checkpoints Incomplete` and `vault-cli --project <name> checkpoints Done`. The save procedure uses `vault-cli --project <name> checkpoints Incomplete`.

For generic `<project> <question>`, use `vault-cli --project <name> checkpoints` or `vault-cli search <terms>` as needed.
