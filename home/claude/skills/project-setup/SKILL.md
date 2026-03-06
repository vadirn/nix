---
name: project-setup
description: Sets up project-as-a-skill for any project. Use "link" to connect an existing skill folder. Use without arguments (or "new") to create a full project from scratch. Use whenever the user wants to set up a new project, initialize project tracking in Obsidian, link a vault folder to a repo, create checkpoint tracking, or scaffold project skills.
---

# Setup Project

Creates or links a project-as-a-skill.

Requires `obsidian` CLI (1.12+). If unavailable, the skill falls back to asking the user for vault paths manually.

## Pseudocode

```
vault_root = discover_vault_root()

if command == "link":
    link(vault_root)
elif command == "check-permissions":
    check_permissions(vault_root)
else:
    setup(vault_root)  // handles "already exists" via duplicate check
```

## Link command

Links an existing vault project folder to the current repo.

### Pseudocode

```
link(vault_root):
    path = ask "Vault path?" (e.g. "41 projects/visa-agent")
    target = "<vault_root>/<path>"

    if target/context.md does not exist:
        error "No context.md found at <target>. Use /project-setup new to create one."
        return

    name = last segment of path  // e.g. "visa-agent" from "41 projects/visa-agent"
    title = infer from context.md heading or ask user

    write_vault_config()    // .claude/.vault.config.json in repo
    write_thin_wrapper()    // .claude/skills/<name>/SKILL.md in repo
    register_in_settings()  // add Skill(<name>), Skill(vault), Read, Bash(vault-cli *)
    report linked, suggest /clear
```

## Check-permissions command

Verifies a project skill has the right entries in `.claude/settings.local.json`.

### Pseudocode

```
check_permissions(vault_root):
    name = ask "Which project skill?" or infer from context
    skill_dir = ".claude/skills/<name>"
    if skill_dir does not exist:
        error "No skill named <name>. Run /project-setup link first."
        return

    real_dir = resolve symlinks of skill_dir  // realpath
    path = relative path of real_dir within vault_root

    settings_file = .claude/settings.local.json
    Read(settings_file)
    expected_skill = "Skill(<name>)"
    expected_read = "Read(<vault_root>/<path>/**)"
    missing = items from [expected_skill, expected_read] not in allow list
    if missing:
        add missing to allow list, report added
    else:
        report all present
```

## Setup command (default)

Creates the full project-as-a-skill structure for a new project.

### Pseudocode

```
setup(vault_root):
    inputs = collect(path, name, title, description, result)
    check_duplicates(vault_root, inputs)  // covers "already set up" case, offers to link instead

    target = "<vault_root>/<path>"
    if target/SKILL.md exists:
        ask "Skill files already exist. Link instead?" (yes/no)
        if yes:
            link(vault_root)  // reuse link flow
            return

    mkdir target
    write_project_note()        // from Project.md template
    write_checkpoints_base()    // via Bash cat (oxfmt mangles .base)
    write_context_md()          // context.md only (no SKILL.md, start.md, save.md — vault skill handles routing)
    write_vault_config()        // .claude/.vault.config.json in repo
    write_thin_wrapper()        // .claude/skills/<name>/SKILL.md in repo (delegates to /vault)
    register_in_settings()      // add Skill(<name>), Skill(vault), Read, Bash(vault-cli *)
    report created files, suggest /clear
```

## Reference

### Discovering vault root

Run `timeout 30 obsidian vaults verbose`.
One vault → use its path. Multiple → `AskUserQuestion`. Command fails → ask user for absolute path.
Store as `<vault_root>`.

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

### Writing Checkpoints.base

Path: `<vault_root>/<path>/Checkpoints.base`
Write via Bash `cat` (oxfmt mangles YAML in `.base` files). See template below.

### Writing context.md

In `<vault_root>/<path>/context.md`. Substitute `<path>`, `<title>`, `<description>`, `<result>`. See context.md template.

No SKILL.md, start.md, or save.md in the vault project folder. The /vault skill handles routing.

### Writing .vault.config.json

Path: `<repo>/.claude/.vault.config.json`

```json
{
  "vault_root": "<vault_root>",
  "project": {
    "name": "<name>",
    "title": "<title>",
    "path": "<path>"
  }
}
```

After writing, ensure `.claude/.vault.config.json` is in `.gitignore` (it contains absolute paths). Read `.gitignore`, append the line if missing.

### Writing thin wrapper skill

Path: `<repo>/.claude/skills/<name>/SKILL.md`

See thin wrapper template below.

### Registering in settings

Read `.claude/settings.local.json` (user-specific, absolute paths don't belong in shared settings). Add these entries to the `allow` list:

- `Skill(<name>)` — insert alphabetically among existing `Skill(...)` entries
- `Skill(vault)` — the universal vault skill
- `Read(<vault_root>/<path>/**)` — allows reading project files and checkpoints from the vault
- `Bash(vault-cli *)` — allows vault-cli commands
- `Bash(~/.claude/skills/vault/scripts/vault-cli *)` — full path variant

## Checkpoints.base template

Substitute `<path>` with the actual vault path before writing. Write via Bash `cat`, because oxfmt mangles `.base` files.

Template: `Read(dir/templates/checkpoints-base.yaml)`. Replace all `<path>` occurrences with the actual vault path.

## Thin wrapper template

Per-repo convenience skill at `<repo>/.claude/skills/<name>/SKILL.md`. Substitute `<name>`, `<title>`.

````markdown
---
name: <name>
description: "<title> project sessions. Use /<name> start to resume or /<name> save to checkpoint."
---

Delegates to /vault.

```
config = Read(.claude/.vault.config.json)
command = user's command after /<name>
Skill(vault) with "{config.project.name} {command}"
```
````

## context.md template

Per-project context. Substitute `<path>`, `<title>`, `<description>`, `<result>`.

```markdown
# <title> Context

<description>

- Project note: [[<path>/<title>]]
- Checkpoints: `<path>/`

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
- Write checkpoints via the Write tool. `obsidian create` fails with multiline content.
- Query checkpoints via `base:query`. `obsidian search` breaks on paths with spaces.
