---
name: vault
description: >
  Personal knowledge management in an Obsidian vault. Use this skill whenever the user wants to save, find, review,
  or organize knowledge — even if they don't say "vault" or "Obsidian". Triggers on: saving a link/article/video/book
  for later (creates a reference in 10 references/), distilling a concept or takeaway from something they read/watched
  (creates a card in 20 cards/), writing down an original idea, observation, or synthesis connecting multiple concepts
  (creates a note in 30 notes/), searching or browsing what they know about a topic, quizzing or testing recall on
  saved concepts, listing or filtering cards by tag, checking project status or open checkpoints, reading a specific
  checkpoint by name or date, listing active or current projects ("which projects am I working on", "project status
  overview", "what are my open projects"). Also handles explicit /vault commands (search, card, note, reference, review,
  cards, projects, start, save, validate). XP/streak reports use `vault-query xp`. Also triggers on weekly log
  operations: adding tasks to backlog ("добавь в бэклог", "backlog"), planning tasks for the week, completing tasks,
  tracking sleep, or any mention of weekly planning, task lists, or activity log. Triggers on session save/checkpoint:
  "wrapping up", "save what we did", "log what we accomplished", "save our progress", "end of session", "save session",
  "we finished X and still need to do Y", resuming or saving progress on a project. DO NOT USE for: editing specific
  Obsidian markdown files directly (callout blocks, formatting, syntax), Obsidian app features (kanban boards, canvas
  files, graph view, plugins, settings, UI configuration), editing .base files, creating canvas files, or general web
  search. The distinction: vault skill manages *what you know* (saving, finding, reviewing knowledge); it does not
  edit raw markdown files or configure the Obsidian app.
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
    week_file = Bash(vault-query log)
    log = Read(week_file)
    do("show current week's log, ask what user wants to do")

elif "validate":
    schemas = skill base directory + "/schemas"
    root_config = "~/.claude/.vault.config.json"
    project_config = ".claude/.vault.config.json"  // in current repo

    if root_config exists:
        Bash(check-jsonschema --schemafile {schemas}/root.config.schema.json {root_config})
    if project_config exists:
        Bash(check-jsonschema --schemafile {schemas}/project.config.schema.json {project_config})
    if neither exists:
        do("tell user no config files found")
    do("report validation results")

elif user mentions a note/card/reference/checkpoint by name:
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
| checkpoint | `41 projects/<project>/`    | Session snapshot. Tracks progress, decisions, frictions |
| weekly-log | `41 projects/block-buster/` | Weekly plan/tasks/activity log for gamified tracking    |

### vault-query subcommands

| Command                        | Description                                    | Requires config |
| ------------------------------ | ---------------------------------------------- | --------------- |
| `config`                       | Print resolved config JSON                     | No              |
| `context`                      | Print project context.md                       | Yes             |
| `checkpoints [--view <view>]`  | Query checkpoints (All/Incomplete/Done/Stats)  | Yes             |
| `get <fragment>`               | Find and read a note/card/reference/checkpoint | No              |
| `search <query>`               | BM25 full-text search (--regex for grep mode)  | No              |
| `projects [--view <view>]`     | List active projects                           | No              |
| `cards`                        | List all cards with metadata                   | No              |
| `notes`                        | List all notes with metadata                   | No              |
| `log [DATE\|WEEK\|last\|next]` | Open or create weekly log                      | No              |
| `xp [YEAR]`                    | XP report: calendar, streak, level             | No              |

### Project commands

`<project> start` and `<project> save` resolve the project via `--project <name>` flag, which uses the root config (`~/.claude/.vault.config.json`) to find `{vault_root}/{projects_path}/<name>`. This works from any directory. If called from a repo with `.claude/.vault.config.json`, the local project config takes precedence unless `--project` is given.

The start procedure uses `vault-query --project <name> checkpoints --view Incomplete` and `vault-query --project <name> checkpoints --view Done`. The save procedure uses `vault-query --project <name> checkpoints --view Incomplete`.

For generic `<project> <question>`, use `vault-query --project <name> checkpoints` or `vault-query search <terms>` as needed.
