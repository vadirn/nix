---
name: project-setup
description: Scaffold a vault project folder and link the current repo via .vault.config.json. Use on /project-setup or "set up a new project".
---

# Setup Project

Writes `.vault.config.json` in the current repo, and creates the vault project folder if it doesn't exist yet.

```
// Discover vault root
config = Read($HOME/.config/vault/config.json)
if not config:
    vault_root = AskUserQuestion("Vault root absolute path?")
    projects_path = AskUserQuestion("Projects subpath within vault? (e.g. '41 projects')")
    Write($HOME/.config/vault/config.json, {vault_root, projects_path})
else:
    vault_root = config.vault_root

// Locate project
path = AskUserQuestion("Vault path? (e.g. '41 projects/my-project')")
target = "<vault_root>/<path>"

// Wire-only branch: project already exists
if <target> directory exists:
    if not Read(<target>/context.md):
        Write(<target>/context.md, do("fill context.md template — see Reference"))
    Write(<repo>/.vault.config.json, {vault_root, project_path: target})
    gitignore = Read(<repo>/.gitignore)
    if ".vault.config.json" not in gitignore: do("append it")
    do("report repo wired to existing project"), stop

// Create branch: new project
title = AskUserQuestion("Project title? (human-readable)")
description = AskUserQuestion("Description? (1-2 sentences)")
result = AskUserQuestion("Result? (one sentence — what 'done' looks like)")

Bash(mkdir -p <target>)
template = Read(<vault_root>/templates/Project.md)
if template:
    Write(<target>/<title>.md, do("fill template: status=in progress, result, replace <path> and description placeholders"))
else:
    Write(<target>/<title>.md, do("write minimal project note: frontmatter with status=in progress; body with description and result fields"))
    do("report that <vault_root>/templates/Project.md was not found; note was created from defaults")
Write(<target>/context.md, do("fill context.md template — see Reference"))

Write(<repo>/.vault.config.json, {vault_root, project_path: target})
gitignore = Read(<repo>/.gitignore)
if ".vault.config.json" not in gitignore: do("append it")

do("report created files")
```

## Reference

### Root config

`$HOME/.config/vault/config.json`. Schema: `~/.claude/skills/vault/schemas/root.config.schema.json`.

```json
{
  "vault_root": "<absolute path>",
  "projects_path": "<vault-relative subpath>"
}
```

`projects_path` is used by `vault-query` for project resolution; this skill only stores it.

### Per-repo config

`<repo>/.vault.config.json`. Schema: `~/.claude/skills/vault/schemas/project.config.schema.json`.

```json
{
  "vault_root": "<absolute path>",
  "project_path": "<absolute path to project folder>"
}
```

Both values are absolute. `project_path` is `vault_root` joined with the vault-relative `path`. Gitignored because it contains absolute paths.

### Project note

Path: `<vault_root>/<path>/<Title>.md`. Template: `<vault_root>/templates/Project.md`.

Substitutions: `<path>` placeholders in body, description comment, `result` and `status: in progress` in frontmatter.

### context.md template

Substitute `<path>`, `<title>`, `<description>`, `<result>`.

```markdown
---
# stakeholders: read by the `brief` skill. One entry per person; brief writes only each
# `last_drafted`. Everything else is yours. Delete the block if unused. Repo paths are NOT
# stored here — they differ per device; brief reads the git repo containing cwd.
# stakeholders:
#   - name: Sarah
#     role: PM                     # optional; no brief logic branches on it
#     currency: [features, dates]  # units they count in; brief translates work into these
#     model: thinks the migration is nearly done   # their current belief about the state
#     inspects: []                 # what they close themselves (e.g. [PRs]); [] = waits to be told
#     last_drafted:                # YYYY-MM-DD, written by brief on an accepted draft
---

# <title> Context

<description>

- Project note: [[<path>/<title>]]

## Result

<result>

## Tech stack

<!-- filled by user or Claude during setup -->

## Conventions

<!-- project-specific conventions -->
```

## Notes

- Generated files live in the vault. Wikilinks work.
- Save and resume sessions via `/track`.
