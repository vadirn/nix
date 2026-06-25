---
name: vault
description: >
  Personal knowledge management in an Obsidian vault. Use whenever the user wants to save, find, review, or organize
  knowledge, even without saying "vault". Triggers: saving links/articles as references, distilling concepts into
  cards, writing original notes, searching or quizzing saved content, listing active projects ("what am I working
  on"), explicit /vault commands, weekly-log operations (backlog/бэклог, planning, completing tasks, sleep). Excludes
  direct file edits not routed through /vault (editing a .md file in a code repo that is not a vault
  artifact), Obsidian app features (kanban, canvas, plugins, .base), web search.
  Skip for session save/resume ("wrapping up", "where did we leave off") — use /track.
---

# Vault

Universal Obsidian vault skill.

```
// vault-query is on PATH; call it directly as `vault-query`
dir = skill base directory

// Route by command
if "search <query>":
    Read(dir/references/search.md)
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

elif "experiments":
    results = Bash(vault-query experiments)
    do("present experiments with metadata: date, verdict, description")

elif "projects":
    results = Bash(vault-query projects)
    do("present projects with status")

// Project commands — load context once
elif "<project> ...":
    project_context ??= Bash(vault-query --project <project> context)
    do("answer using project context, search as needed")

elif "log" or weekly log intent:
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

elif user names an entry by name:   // entry = note/card/reference/checkpoint/track/experiment
    paths = Bash(vault-query get <fragment>)   // resolves to absolute path(s), one per line
    if single match:
        path = paths[0]
        if outline wanted or large/structured entry:
            Bash(vault-query read <path>)            // folded overview
            Bash(vault-query read <path> <address>)  // unfold the relevant section
        else:
            Read(path)                               // full content
        do("summarize content")
    elif multiple matches: AskUserQuestion("which one?")
    else: do("offer to search")

else:
    Bash(vault-query config)
    do("help user with their request")
```

## Reference

### Glossary

Vault entities, each defined by what sets it apart from adjacent ones.

| Term                                      | Definition                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Location                                    |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Entry                                     | General term for any vault file. Typed entries (card, note, reference, track, checkpoint, context, experiment, …) are durable and live in their home folder. Untyped entries are raw captures that live in the inbox only.                                                                                                                                                                                                                                              | vault-wide                                  |
| Superseded marker                         | `superseded: true` in frontmatter, with optional `superseded_by: "[[...]]"`, marks an entry obsolete while keeping it on disk. Distinct from `status`: `status` tracks project lifecycle; `superseded` marks content replaced by another entry. `consult` excludes superseded entries by default (`--include-superseded` restores them). `search`/`list`/`get`/`backlinks` include them with a `[superseded]` label and BM25 downrank; `--no-superseded` excludes them. | frontmatter                                 |
| Inbox                                     | Staging area for new captures awaiting triage: raw link-stubs and freshly created references, cards, and notes alike live here before the user files each to its folder. Classification is by the `type:` field, not the folder, so a typed item counts as its type from creation.                                                                                                                                                                                      | `00 inbox/`                                 |
| Reference                                 | Pointer to an external source (article, book, video, talk). Captured and classified with tags, no analysis. Distinct from a card: a reference holds the source, a card holds the idea drawn from it.                                                                                                                                                                                                                                                                    | `00 inbox/` → `10 references/`              |
| Card                                      | One concept distilled from one or more external references, in your own words. The `reference:` field records its sources and marks the file as a card. Distinct from a note: a card distils external sources, a note is original.                                                                                                                                                                                                                                      | `00 inbox/` → `20 cards/`                   |
| Note                                      | Original thinking, free-form; carries no `reference:` field. Stands alone or links ideas across cards and references. Distinct from a card: a note is original, a card distils external sources. Work-specific notes use `31 work notes/` (same format).                                                                                                                                                                                                                | `00 inbox/` → `30 notes/`, `31 work notes/` |
| Goal                                      | High-level aspiration with success criteria. Nests via the `goal:` field on a child goal. Distinct from a project: the goal is the _why_, the project is a deliverable that advances it.                                                                                                                                                                                                                                                                                | `41 projects/`                              |
| Project                                   | Concrete deliverable linked to a goal. Has `result`, `status`, optional `deadline`. Single file, or a subfolder when work fans out. Distinct from a track: the project is the unit of intent, the track is the unit of working memory across sessions.                                                                                                                                                                                                                  | `41 projects/<project>/`                    |
| Project context                           | Stable per-project framing (purpose, conventions, links) read by `vault-query --project <name> context`. Distinct from a track: context is durable framing, a track is rolling state.                                                                                                                                                                                                                                                                                   | `41 projects/<project>/context.md`          |
| Track                                     | Rolling per-project work artifact (sections: Direction, Decisions, Backlog, Log). One file per multi-session effort, appended across the sessions it spans. Owned by the `/track` skill. Distinct from a checkpoint: a track accumulates state in place; a checkpoint was a one-shot snapshot.                                                                                                                                                                          | `41 projects/<project>/track-<slug>.md`     |
| Experiment                                | Captured behavior test of an existing thing against a falsifiable claim. Frontmatter `type: experiment`, `verdict` (confirmed/refuted/inconclusive), `date`, optional `project` wikilink. Owned by the `/experiment` skill. Distinct from a track: an experiment is one decided question, a track is a multi-session effort.                                                                                                                                            | `35 experiments/`                           |
| Checkpoint _(legacy — replaced by track)_ | Single-session snapshot recording decisions, frictions, cost, lines written. New work goes to track; existing files remain reachable via `vault-query get` (resolves the path; Read it). Programmatically treated as superseded: `consult` excludes all checkpoints by default.                                                                                                                                                                                         | `41 projects/<project>/`                    |
| Weekly log                                | ISO-week file with Focus, Tasks, Backlog, Activity sections. Tasks wikilink to projects; Activity is auto-appended by a git post-commit hook. Distinct from a track: a weekly log spans all projects for one week, a track spans one project across all weeks.                                                                                                                                                                                                          | `41 projects/block-buster/YYYY-wWW.md`      |
| Base                                      | Obsidian Base file — a saved cross-vault query rendered as a table/board view. Distinct from a search: a base is a persistent named view; a search is a one-shot query.                                                                                                                                                                                                                                                                                                 | `90 bases/`                                 |

### vault-query subcommands

| Command                            | Description                                                                                                                                                                                                     | Requires config |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `config`                           | Print resolved config JSON                                                                                                                                                                                      | No              |
| `context`                          | Print project context.md                                                                                                                                                                                        | Yes             |
| `tracks [--view <view>]`           | Query project tracks (Active/Open/Paused/Done/Abandoned/Superseded/All/Stats), updated DESC                                                                                                                     | Yes             |
| `tracks-init`                      | Create Tracks.base in the current project                                                                                                                                                                       | Yes             |
| `get <fragment>`                   | Resolve an entry name to its absolute path (one per line); Read the path for content                                                                                                                            | No              |
| `read <FILE> [ADDRESS]`            | Structured read of a .md file: folded overview, or unfold a section by ADDRESS (numeric `2.1`, heading slug, or `0`/text). `--depth`, `--full`, `--threshold`, `--format json`. Pairs with `get` (path in)      | No              |
| `search <query>`                   | BM25 full-text search (--regex for grep mode)                                                                                                                                                                   | No              |
| `projects [--view <view>]`         | List active projects                                                                                                                                                                                            | No              |
| `cards`                            | List all cards with metadata                                                                                                                                                                                    | No              |
| `notes`                            | List all notes with metadata                                                                                                                                                                                    | No              |
| `experiments`                      | List all experiments with metadata                                                                                                                                                                              | No              |
| `log [DATE\|WEEK\|last\|next]`     | Open or create weekly log                                                                                                                                                                                       | No              |
| `lint [--format ...] [--rule ...]` | Vault-wide lint: orphan-card (superseded entries exempt), dangling-reference, reference-not-wikilink, broken-wikilink, untagged-card, singleton-tag, oversized-entry (superseded entries exempt), untyped-entry | Yes             |
| `xp [YEAR]`                        | XP report: calendar, streak, level                                                                                                                                                                              | No              |

### Project commands

Track operations are handled by the /track skill. For generic `<project> <question>`, use `vault-query --project <name> context` or `vault-query search <terms>` as needed.
