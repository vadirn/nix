---
name: setup-project
description: Sets up project-as-a-skill for any project. Creates project note, Checkpoints.base, command router SKILL.md, symlink, and settings registration.
---

# Setup Project

Creates the full project-as-a-skill structure for a new project.

## Process

1. **Collect inputs** (ask the user):
   - Project name — kebab-case, used for directory and skill name (e.g. `my-project`)
   - Project title — human-readable (e.g. `My Project`)
   - Description — 1-2 sentences, what this project is
   - Result — what "done" looks like (1 sentence)

2. **Duplicate check** (before creating anything):
   - Glob `41 projects/{name}/`
   - Glob `.claude/skills/{name}/`
   - If either exists, ask whether to proceed or edit the existing project

3. **Create directory**: `mkdir -p "41 projects/{name}"`

4. **Write project note**: `41 projects/{name}/{Title}.md`
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

5. **Write Checkpoints.base**: `41 projects/{name}/Checkpoints.base`
   Write via Bash `cat` to bypass oxfmt, which mangles YAML in `.base` files. Build the final YAML with the actual project name substituted. See template below.

6. **Write command router**: `41 projects/{name}/SKILL.md`
   Use the generated SKILL.md template below. Substitute all `{name}`, `{title}`, `{description}` placeholders with actual values.

7. **Write checkpoint template**: `templates/Checkpoint.md`
   Create only if missing (Glob first).

8. **Create symlink**:

   ```bash
   ln -s "../../41 projects/{name}" ".claude/skills/{name}"
   ```

   Relative path, portable across machines.

9. **Register in settings**: add `Skill({name})` to the `allow` list in `.claude/settings.json`. Read the file first, insert alphabetically among existing `Skill(...)` entries.

10. **Report**: list all created files. Remind the user to `/clear` so the new skill loads.

## Checkpoints.base template

Substitute `{name}` with the actual project name before writing. Write via Bash `cat`, because oxfmt mangles `.base` files.

```yaml
filters:
  and:
    - type == "checkpoint"
    - file.inFolder("41 projects/{name}")
properties:
  file.name:
    displayName: Checkpoint
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
      - done
      - decisions
      - frictions
    sort:
      - property: file.name
        direction: DESC
```

## Generated SKILL.md template

Per-project command router. Substitute `{name}`, `{title}`, `{description}` with actual values.

````markdown
---
name: { name }
description: { description }
---

# {title}

## Context

{description}

- Project note: [[41 projects/{name}/{title}]]
- Checkpoints: `41 projects/{name}/`

<!-- Add context below: tech stack, related cards, conventions -->

## Commands

### `start`

Resume or begin a session.

1. Context loaded (you read this file).
2. Query incomplete checkpoints:
   ```
   obsidian base:query path="41 projects/{name}/Checkpoints.base" view="Incomplete"
   ```
   Bash timeout: 30000. Fallback when Obsidian is offline:
   ```
   Glob: 41 projects/{name}/checkpoint-*.md
   ```
   Then Read each and check `done: false` in frontmatter.
3. Report:
   - Zero checkpoints → "First session."
   - Incomplete checkpoints → Read each. Show `## Progress` and `## Next`.
   - All complete → Read the latest (filename sort DESC) for continuity.
4. Ask what to work on.

### `save`

Write a checkpoint. Interactive.

1. Query incomplete checkpoints (same method as `start`).
2. For each incomplete checkpoint: ask if this session resolves it.
   - Yes → update in place (Read, then Write). Ask "mark done?"
   - No → move on.
3. New work uncovered by existing checkpoints:
   - Create `checkpoint-{UTC timestamp}.md` via Write tool
   - UTC timestamp format: `YYYY-MM-DD-HH-mm-ss` (use `date -u +%Y-%m-%d-%H-%M-%S`)
   - Template: `templates/Checkpoint.md`
   - Fill frontmatter:
     - `type: checkpoint`
     - `done: false` (or `true` if complete)
     - `project: "[[41 projects/{name}/{title}]]"`
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
