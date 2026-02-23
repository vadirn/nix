---
name: project-setup
description: Sets up project-as-a-skill for any project. Creates project note, Checkpoints.base, command router SKILL.md, symlink, and settings registration.
---

# Setup Project

Creates the full project-as-a-skill structure for a new project.

## Process

1. **Discover vault root**:
   - Run `timeout 10 obsidian vaults verbose` (Bash timeout 10000).
   - One vault → use its filesystem path. Multiple → ask user to pick via `AskUserQuestion`. Command fails or Obsidian offline → ask user for the absolute filesystem path.
   - Store as `{vault_root}` (absolute path, e.g. `/Users/vadim/Documents/vault`).

2. **Collect inputs** (ask the user):
   - Vault path — where the project lives in the vault (e.g. `41 projects/subarea/my-project`). No default. If not provided, stop.
   - Project name — kebab-case, used for skill name (e.g. `my-project`)
   - Project title — human-readable (e.g. `My Project`)
   - Description — 1-2 sentences, what this project is
   - Result — what "done" looks like (1 sentence)

3. **Duplicate check** (before creating anything):
   - Glob `{vault_root}/{path}/`
   - Glob `.claude/skills/{name}/`
   - If either exists, ask whether to proceed or edit the existing project

4. **Create directory**: `mkdir -p "{vault_root}/{path}"`

5. **Write project note**: `{vault_root}/{path}/{Title}.md`
   Use the Project template frontmatter:

   ```yaml
   ---
   type: project
   result: { result }
   status: in progress
   deadline:
   goal:
   ---
   ```

   Body: the description, plus any context the user provides.

6. **Write Checkpoints.base**: `{vault_root}/{path}/Checkpoints.base`
   Write via Bash `cat` to bypass oxfmt, which mangles YAML in `.base` files. Build the final YAML with the actual project name substituted. See template below.

7. **Write command router**: `{vault_root}/{path}/SKILL.md`
   Use the generated SKILL.md template below. Substitute all `{vault_root}`, `{path}`, `{name}`, `{title}`, `{description}` placeholders with actual values.

8. **Write checkpoint template**: `{vault_root}/templates/Checkpoint.md`
   Create only if missing (Glob first).

9. **Create symlink**:

   ```bash
   mkdir -p .claude/skills && ln -s "{vault_root}/{path}" ".claude/skills/{name}"
   ```

   Absolute path so it works from any repo.

10. **Register in settings**: add `Skill({name})` to the `allow` list in `.claude/settings.json` or `.claude/settings.local.json`. Glob `.claude/settings*.json` first to find the right file. Read it, insert alphabetically among existing `Skill(...)` entries.

11. **Report**: list all created files. Remind the user to `/clear` so the new skill loads.

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

## Generated SKILL.md template

Per-project command router. Substitute `{vault_root}`, `{path}`, `{name}`, `{title}`, `{description}` with actual values.

````markdown
---
name: { name }
description: { description }
---

# {title}

## Context

{description}

- Project note: [[{path}/{title}]]
- Checkpoints: `{path}/`

<!-- Add context below: tech stack, related cards, conventions -->

## Commands

### `start`

Resume or begin a session.

1. Context loaded (you read this file).
2. Query incomplete checkpoints:
   ```
   timeout 30 obsidian base:query path="{path}/Checkpoints.base" view="Incomplete"
   ```
   Bash timeout: 30000. Fallback when Obsidian is offline:
   ```
   Glob: {vault_root}/{path}/checkpoint-*.md
   ```
   Then Read each and check `done: false` in frontmatter.
3. Report:
   - Zero checkpoints → "First session."
   - All complete → "All checkpoints done." Skip to step 4.
   - Incomplete checkpoints → present via `AskUserQuestion` with `multiSelect: true`. Each option: description (fall back to filename if missing). Include an "All" option.
     Read selected checkpoints. Show `## Progress` and `## Next` from each.
4. Ask what to work on.

### `save`

Write a checkpoint. Interactive.

1. Query incomplete checkpoints (same method as `start`).
2. For each incomplete checkpoint: ask if this session resolves it.
   - Yes → update in place (Read, then Write). Ask "mark done?"
   - No → move on.
3. New work uncovered by existing checkpoints:
   - Create `{vault_root}/{path}/checkpoint-{UTC timestamp}.md` via Write tool
   - UTC timestamp format: `YYYY-MM-DD-HH-mm-ss` (use `date -u +%Y-%m-%d-%H-%M-%S`)
   - Template: `{vault_root}/templates/Checkpoint.md`
   - Fill frontmatter:
     - `type: checkpoint`
     - `description: "short summary of this checkpoint"` — generate from session context, ask user to confirm or edit
     - `done: false` (or `true` if complete)
     - `project: "[[{path}/{title}]]"`
     - `decisions: ["chose X because Y"]` — key decisions this session
     - `frictions: ["had to work around Z"]` — friction points encountered
   - Fill body:
     - `## Progress` — what happened (concrete changes, files, code state)
     - `## Next` — remaining work across full breadth (all parts, not just current area)
4. Graduation candidates: review this session's decisions and frictions.
   - Propose which could graduate to CLAUDE.md, repo skills, or vault notes.
   - Present as suggestions. Let the user decide.
5. Suggest `/clear` to free context.
````

## Notes

- `/clear` or restart is required after setup for the new skill to load.
- The generated SKILL.md lives in the vault. Wikilinks work. The user adds links to related cards/notes in the Context section.
- Write checkpoints via the Write tool. `obsidian create` fails with multiline content.
- Query checkpoints via `base:query`. `obsidian search` breaks on paths with spaces.
