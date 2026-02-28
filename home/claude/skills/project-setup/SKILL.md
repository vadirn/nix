---
name: project-setup
description: Sets up project-as-a-skill for any project. Creates project note, Checkpoints.base, Stats.base, skill files (SKILL.md, context.md, start.md, save.md), symlink, and settings registration.
---

# Setup Project

Creates the full project-as-a-skill structure for a new project.

## Pseudocode

```
vault_root = discover_vault_root()
inputs = collect(path, name, title, description, result)
check_duplicates(vault_root, inputs)

mkdir "{vault_root}/{path}"
write_project_note()        // from Project.md template
write_checkpoints_base()    // via Bash cat (oxfmt mangles .base)
write_stats_base()          // via Bash cat
write_skill_files()         // SKILL.md, context.md, start.md, save.md
write_checkpoint_template() // only if missing
create_symlink()            // .claude/skills/{name} → {vault_root}/{path}
register_in_settings()      // add Skill({name}) to allow list
report created files, suggest /clear
```

## Reference

### Discovering vault root

Run `timeout 30 obsidian vaults verbose`.
One vault → use its path. Multiple → `AskUserQuestion`. Command fails → ask user for absolute path.
Store as `{vault_root}`.

### Collecting inputs

Ask the user:

- **Vault path** — where the project lives (e.g. `41 projects/subarea/my-project`). Required.
- **Project name** — kebab-case skill name (e.g. `my-project`)
- **Project title** — human-readable (e.g. `My Project`)
- **Description** — 1-2 sentences
- **Result** — what "done" looks like (1 sentence)

### Duplicate check

- Glob `{vault_root}/{path}/` and `.claude/skills/{name}/`
- If either exists, ask whether to proceed or edit existing

### Writing the project note

Path: `{vault_root}/{path}/{Title}.md`
Template: `{vault_root}/templates/Project.md`. Fill frontmatter (`result`, `status: in progress`). Replace `{path}` placeholders in body. Replace description comment with real description.

### Writing Checkpoints.base

Path: `{vault_root}/{path}/Checkpoints.base`
Write via Bash `cat` (oxfmt mangles YAML in `.base` files). See template below.

### Writing Stats.base

Path: `{vault_root}/{path}/Stats.base`
Write via Bash `cat`. See template below.

### Writing skill files

All in `{vault_root}/{path}/`:

- **SKILL.md** (command router): substitute `{name}`, `{title}`, `{description}`. See SKILL.md template.
- **context.md**: substitute `{path}`, `{title}`, `{description}`. See context.md template.
- **start.md**: substitute `{vault_root}`, `{path}`. See start.md template.
- **save.md**: substitute `{vault_root}`, `{path}`, `{title}`. See save.md template.

### Writing checkpoint template

Path: `{vault_root}/templates/Checkpoint.md`
Create only if missing (Glob first).

### Creating symlink

```bash
mkdir -p .claude/skills && ln -s "{vault_root}/{path}" ".claude/skills/{name}"
```

Absolute path so it works from any repo.

### Registering in settings

Add `Skill({name})` to the `allow` list in `.claude/settings.json` or `.claude/settings.local.json`. Glob `.claude/settings*.json` first. Read, insert alphabetically among existing `Skill(...)` entries.

## Checkpoints.base template

Substitute `{path}` with the actual vault path before writing. Write via Bash `cat`, because oxfmt mangles `.base` files.

```yaml
filters:
  and:
    - type == "checkpoint"
    - file.inFolder("{path}")
properties:
  file.name:
    displayName: Checkpoint
  note.description:
    displayName: Description
  note.done:
    displayName: Done
  note.decisions:
    displayName: Decisions
  note.frictions:
    displayName: Frictions
views:
  - type: table
    name: All
    order:
      - file.name
      - description
      - done
      - decisions
      - frictions
    sort:
      - property: file.name
        direction: DESC
  - type: table
    name: Incomplete
    filters:
      and:
        - done == false
    order:
      - file.name
      - description
      - decisions
      - frictions
    sort:
      - property: file.name
        direction: DESC
  - type: table
    name: Graduation queue
    filters:
      or:
        - decisions.length > 0
        - frictions.length > 0
    order:
      - file.name
      - description
      - done
      - decisions
      - frictions
    sort:
      - property: file.name
        direction: DESC
```

## Stats.base template

Substitute `{path}` with the actual vault path before writing. Write via Bash `cat`, because oxfmt mangles `.base` files.

```yaml
filters:
  and:
    - type == "checkpoint"
    - file.inFolder("{path}")
formulas:
  cost_per_line: 'if(lines_written > 0, (cost_usd / lines_written).round(3), "")'
  lines_per_turn: 'if(turns_to_edit > 0, (lines_written / turns_to_edit).round(1), "")'
properties:
  file.name:
    displayName: Session
  note.description:
    displayName: Description
  note.cost_usd:
    displayName: Cost ($)
  note.lines_written:
    displayName: Lines
  note.turns_to_edit:
    displayName: Turns
  formula.cost_per_line:
    displayName: $/line
  formula.lines_per_turn:
    displayName: Lines/turn
views:
  - type: table
    name: All
    order:
      - file.name
      - description
      - cost_usd
      - lines_written
      - turns_to_edit
      - formula.cost_per_line
      - formula.lines_per_turn
    sort:
      - property: file.name
        direction: DESC
    summaries:
      cost_usd: Sum
      lines_written: Sum
      turns_to_edit: Sum
      formula.cost_per_line: Average
      formula.lines_per_turn: Average
```

## SKILL.md template

Per-project command router. Substitute `{name}`, `{title}`, `{description}`.

````markdown
---
name: { name }
description: { description }
---

# {title}

```
dir = directory containing this file

Read(dir/context.md)

if command == "start":
    Read(dir/start.md)
    follow procedure
elif command == "save":
    Read(dir/save.md)
    follow procedure
else:
    use context to navigate the vault
```
````

## context.md template

Per-project context. Substitute `{path}`, `{title}`, `{description}`.

```markdown
# {title} Context

{description}

- Project note: [[{path}/{title}]]
- Checkpoints: `{path}/`

<!-- Add context below: tech stack, related cards, conventions -->
```

## start.md template

Session start procedure. Substitute `{vault_root}`, `{path}`.

````markdown
# Start — resume or begin a session

## Pseudocode

```
checkpoints = query_incomplete_checkpoints()

if checkpoints is empty:
    print "First session."
elif all done:
    print "All checkpoints done."
else:
    selected = AskUserQuestion(checkpoints, multiSelect=true)  // include "All" option
    for each in selected:
        show "## Progress" and "## Next"

ask "What to work on?"
```

## Reference

### Querying incomplete checkpoints

Primary (Obsidian running):

```
timeout 30 obsidian base:query path="{path}/Checkpoints.base" view="Incomplete"
```


Fallback (Obsidian offline):

```
Glob: {vault_root}/{path}/checkpoint-*.md
```

Read each, check `done: false` in frontmatter.

### Presenting checkpoints

Use `AskUserQuestion` with `multiSelect: true`. Each option label: `description` field (fall back to filename if missing). Include an "All" option.

Read selected checkpoints. Show `## Progress` and `## Next` from each.
````

## save.md template

Session save procedure. Substitute `{vault_root}`, `{path}`, `{title}`.

````markdown
# Save — write a checkpoint

## Pseudocode

```
stats = session_stats()  // cost_usd, lines_written, turns_to_edit
checkpoints = query_incomplete_checkpoints()  // same as start.md

for each incomplete checkpoint:
    ask "does this session resolve it?"
    if yes:
        update checkpoint in place (Read, then Write)
        ask "mark done?"

if new work uncovered by existing checkpoints:
    create new checkpoint from template
    fill frontmatter: description, done, project, decisions, frictions, stats
    fill body: ## Progress, ## Next

graduation = review decisions and frictions
propose candidates for CLAUDE.md, skills, or vault notes  // let user decide

suggest "/clear"
```

## Reference

### Session stats

Use the `session-stats` skill. Extract `cost_usd`, `lines_written`, `turns_to_edit` from its output.

### Querying incomplete checkpoints

Same method as `start.md` — see its Reference section.

### Creating a checkpoint

Path: `{vault_root}/{path}/checkpoint-{UTC timestamp}.md`
UTC timestamp: `YYYY-MM-DD-HH-mm-ss` (use `date -u +%Y-%m-%d-%H-%M-%S`)
Template: `{vault_root}/templates/Checkpoint.md`

Frontmatter:

- `type: checkpoint`
- `description` — generate from session context, ask user to confirm or edit
- `done: false` (or `true` if complete)
- `project: "[[{path}/{title}]]"`
- `decisions: ["chose X because Y"]` — key decisions this session
- `frictions: ["had to work around Z"]` — friction points encountered
- `cost_usd`, `lines_written`, `turns_to_edit` — from stats

Body:

- `## Progress` — what happened (concrete changes, files, code state)
- `## Next` — remaining work across full breadth (all parts, not just current area)

### Graduation candidates

Review session decisions and frictions. Propose which could graduate to:

- `CLAUDE.md` (global or project)
- Repo skills
- Vault notes

Present as suggestions. Let the user decide.
````

## Notes

- `/clear` or restart is required after setup for the new skill to load.
- The generated files live in the vault. Wikilinks work. The user adds project-specific context to context.md.
- Write checkpoints via the Write tool. `obsidian create` fails with multiline content.
- Query checkpoints via `base:query`. `obsidian search` breaks on paths with spaces.
