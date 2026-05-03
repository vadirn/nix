---
name: project-setup
description: Sets up project-as-a-skill for any project. Use "link" to connect an existing skill folder. Use without arguments (or "new") to create a full project from scratch. Use whenever the user wants to set up a new project, initialize project tracking in Obsidian, link a vault folder to a repo, or scaffold project skills.
---

# Setup Project

Creates or links a project-as-a-skill.

## Pseudocode

```
vault_root = discover_vault_root()

if command == "link":
    link(vault_root)
elif command == "check-permissions":
    check_permissions(vault_root)
else:
    setup(vault_root)
```

## Link command

Links an existing vault project folder to the current repo.

### Pseudocode

```
link(vault_root):
    path = AskUserQuestion("Vault path? e.g. 41 projects/visa-agent")
    target = "<vault_root>/<path>"

    // Guard
    if not Read(target/context.md):
        do("report missing context.md, suggest /project-setup new")
        stop

    name = do("take last path segment as kebab-case skill name")
    title = do("infer from context.md heading; AskUserQuestion if missing")

    write_vault_config()
    write_thin_wrapper()
    register_in_settings()
    do("report linked, suggest /clear")
```

## Check-permissions command

Verifies a project skill has the right entries in `.claude/settings.local.json`.

### Pseudocode

```
check_permissions(vault_root):
    name = do("infer from context, else AskUserQuestion('which project skill?')")
    skill_dir = ".claude/skills/<name>"

    // Guard
    if not exists(skill_dir):
        do("report no such skill, suggest /project-setup link")
        stop

    real_dir = Bash(realpath <skill_dir>)
    path = do("compute real_dir relative to vault_root")

    settings = Read(.claude/settings.local.json)
    expected_skill = "Skill(<name>)"
    expected_read = "Read(<vault_root>/<path>/**)"
    missing = do("items from [expected_skill, expected_read] not in settings allow list")

    if missing:
        do("add missing to allow list, report added")
    else:
        do("report all present")
```

## Setup command (default)

Creates the full project-as-a-skill structure for a new project.

### Pseudocode

```
setup(vault_root):
    inputs = collect(path, name, title, description, result)
    check_duplicates(vault_root, inputs)

    target = "<vault_root>/<path>"

    // Offer to link if already initialised
    if exists(target/SKILL.md):
        answer = AskUserQuestion("Skill files already exist. Link instead?")
        if answer == "yes":
            link(vault_root)
            stop

    Bash(mkdir -p <target>)
    write_project_note()
    write_context_md()
    write_vault_config()
    write_thin_wrapper()
    register_in_settings()
    do("report created files, suggest /clear")
```

## Reference

### Discovering vault root (root config)

1. Read `$HOME/.config/vault/config.json` (root config)
2. If exists and has `vault_root` → use it
3. If absent → ask user for vault_root and projects_path, then create root config.
   `projects_path` is used by vault-query for project resolution; this skill only stores it.

   Write `$HOME/.config/vault/config.json`:

   ```json
   {
     "vault_root": "<vault_root>",
     "projects_path": "<projects_path>"
   }
   ```

   Schema: `~/.claude/skills/vault/schemas/root.config.schema.json`

### Collecting inputs

Ask the user:

- **Vault path** — where the project lives (e.g. `41 projects/subarea/my-project`). Required.
- **Project name** — kebab-case skill name (e.g. `my-project`)
- **Project title** — human-readable (e.g. `My Project`)
- **Description** — 1-2 sentences
- **Result** — what "done" looks like (1 sentence)

### Duplicate check

- Glob `<vault_root>/<path>/` and `.claude/skills/<name>/`
- If either exists, ask whether to proceed or edit existing

### Writing the project note

Path: `<vault_root>/<path>/<Title>.md`
Template: `<vault_root>/templates/Project.md`. Fill frontmatter (`result`, `status: in progress`). Replace `<path>` placeholders in body. Replace description comment with real description.

### Writing context.md

In `<vault_root>/<path>/context.md`. Substitute `<path>`, `<title>`, `<description>`, `<result>`. See context.md template.

Only context.md goes in the vault project folder. The /vault skill handles routing.

### Writing .vault.config.json (per-repo config)

Path: `<repo>/.vault.config.json`

```json
{
  "vault_root": "<vault_root>",
  "project_path": "<vault_root>/<path>"
}
```

Schema: `~/.claude/skills/vault/schemas/project.config.schema.json`

Both values are absolute paths. `project_path` is `vault_root` joined with the vault-relative path (e.g. `41 projects/nix`).

After writing, add `.vault.config.json` to `.gitignore` (it contains absolute paths). Read `.gitignore`, append the line if missing.

### Writing thin wrapper skill

Path: `<repo>/.claude/skills/<name>/SKILL.md`

See thin wrapper template below.

### Registering in settings

Read `.claude/settings.local.json` (user-specific; absolute paths belong here, not in shared settings). Also read `~/.claude/settings.json` (global). Skip entries already present in the global allow list.

Typically needed (not in global):

- `Skill(<name>)` — the project-specific skill

Skip if already in global settings:

- `Skill(vault)`, `Read` — usually already allowed globally

## Thin wrapper template

Per-repo convenience skill at `<repo>/.claude/skills/<name>/SKILL.md`. Substitute `<name>`, `<title>`.

````markdown
---
name: <name>
description: "<title> project sessions. Use /<name> start to resume or /<name> save to checkpoint."
---

Delegates to /vault.

```
command = user's command after /<name>
Skill(vault) with "<name> <command>"
```
````

## context.md template

Per-project context. Substitute `<path>`, `<title>`, `<description>`, `<result>`.

```markdown
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

- `/clear` or restart is required after setup for the new skill to load.
- The generated files live in the vault. Wikilinks work. The user adds project-specific context to context.md.
