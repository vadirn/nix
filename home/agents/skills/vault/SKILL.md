---
name: vault
description: >
  Personal knowledge management in an Obsidian vault. Use this skill whenever the user wants to save, find, review,
  or organize knowledge — even if they don't say "vault" or "Obsidian". Triggers on: saving a link/article/video/book
  for later (creates a reference in 10 references/), distilling a concept or takeaway from something they read/watched
  (creates a card in 20 cards/), writing down an original idea, observation, or synthesis connecting multiple concepts
  (creates a note in 30 notes/), searching or browsing what they know about a topic, quizzing or testing recall on
  saved concepts, listing or filtering cards by tag, checking project status, listing active or current projects
  ("which projects am I working on", "project status overview", "what are my open projects"). Also handles explicit
  /vault commands (search, card, note, reference, review, cards, projects, validate). XP/streak reports use
  `vault-query xp`. Also triggers on weekly log operations: adding tasks to backlog ("добавь в бэклог", "backlog"),
  planning tasks for the week, completing tasks, tracking sleep, or any mention of weekly planning, task lists, or
  activity log. EXCLUDES: editing specific Obsidian markdown files directly (callout blocks, formatting, syntax),
  Obsidian app features (kanban boards, canvas files, graph view, plugins, settings, UI configuration), editing .base
  files, creating canvas files, or general web search. Track read/save and session save/checkpoint phrases route to
  the /track skill, not here. The distinction: vault skill manages *what you know* (saving, finding, reviewing
  knowledge). Raw markdown editing and Obsidian app configuration are outside this skill's scope.
---

# Vault

Universal Obsidian vault skill.

```
// vault-query is on PATH; call it directly as `vault-query`
dir = skill base directory

// Route by command
if "search <query>":
    results = Bash(vault-query search <query>)
    do("present results with file paths, offer to Read top hits")

elif "card" or "card <topic>":
    Read(dir/references/card.md)
    Read(dir/references/post-edit.md)
    do("follow card creation/editing process; apply post-edit etiquette before wrapping")

elif "note" or "note <topic>":
    Read(dir/references/note.md)
    Read(dir/references/post-edit.md)
    do("follow note creation/editing process; apply post-edit etiquette before wrapping")

elif "reference" or "reference <topic>":
    Read(dir/references/reference.md)
    Read(dir/references/post-edit.md)
    do("follow reference creation/editing process; apply post-edit etiquette before wrapping")

elif "review":
    Read(dir/references/review.md)
    do("follow review process")

elif "cards":
    results = Bash(vault-query cards)
    Read(dir/references/cards.md)
    do("follow cards presentation process with results")

elif "notes":
    results = Bash(vault-query notes)
    do("present notes with metadata")

elif "projects":
    results = Bash(vault-query projects)
    do("present projects with status")

// Project commands — load context once
elif "<project> ...":
    project_context ??= Bash(vault-query --project <project> context)
    do("answer using project context, search as needed")

elif "log" or weekly log intent (planning, tasks, sleep):
    Read(dir/references/log-weekly.md)
    Read(dir/references/post-edit.md)
    week_file = Bash(vault-query log)
    log = Read(week_file)
    do("show current week's log, ask what user wants to do; apply post-edit etiquette before wrapping if log was edited")

elif "lint":
    Read(dir/references/lint.md)
    Bash(vault-query lint [--format <text|json|summary>] [--rule <name>=<severity>] [--no-ignore]...)
    // .vaultignore at vault root excludes paths from all vault-query commands; --no-ignore disables it
    do("present findings; suggest interactive fixes via /vault card, /vault reference, etc.")

elif "validate":
    schemas = skill base directory + "/schemas"
    root_config = "~/.config/vault/config.json"
    project_config = ".vault.config.json"  // in current repo

    if root_config exists:
        Bash(check-jsonschema --schemafile <schemas>/root.config.schema.json <root_config>)
    if project_config exists:
        Bash(check-jsonschema --schemafile <schemas>/project.config.schema.json <project_config>)
    if neither exists:
        do("tell user no config files found")
    do("report validation results")

elif user mentions a note/card/reference/checkpoint/track by name:
    result = Bash(vault-query get <fragment>)
    if single match: do("summarize content")
    elif multiple matches: AskUserQuestion("which one?")
    else: do("offer to search")

else:
    Bash(vault-query config)
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
| checkpoint | `41 projects/<project>/`    | Session snapshot (legacy). Replaced by `track`.         |
| track      | `41 projects/<project>/`    | Rolling per-project work artifact (Direction, Decisions, Backlog, Log) |
| weekly-log | `41 projects/block-buster/` | Weekly plan/tasks/activity log for gamified tracking    |

### vault-query subcommands

| Command                        | Description                                    | Requires config |
| ------------------------------ | ---------------------------------------------- | --------------- |
| `config`                       | Print resolved config JSON                     | No              |
| `context`                      | Print project context.md                       | Yes             |
| `checkpoints [--view <view>]`  | Query checkpoints (All/Incomplete/Done/Stats), legacy | Yes      |
| `tracks [--view <view>]`       | Query project tracks (Active/Open/Paused/Done/Abandoned/Superseded/All/Stats), updated DESC | Yes |
| `tracks-init`                  | Create Tracks.base in the current project     | Yes             |
| `get <fragment>`               | Find and read a note/card/reference/checkpoint/track | No        |
| `search <query>`               | BM25 full-text search (--regex for grep mode)  | No              |
| `projects [--view <view>]`     | List active projects                           | No              |
| `cards`                        | List all cards with metadata                   | No              |
| `notes`                        | List all notes with metadata                   | No              |
| `log [DATE\|WEEK\|last\|next]` | Open or create weekly log                      | No              |
| `lint [--format ...] [--rule ...]` | Vault-wide lint: orphan-card, broken-wikilink, dangling-reference, etc. | Yes |
| `xp [YEAR]`                    | XP report: calendar, streak, level             | No              |

### Project commands

Track operations are handled by the /track skill. For generic `<project> <question>`, use `vault-query --project <name> context` or `vault-query search <terms>` as needed.
