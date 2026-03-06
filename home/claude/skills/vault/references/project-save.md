# Save — write a checkpoint

## Pseudocode

```
stats = session_stats()  // cost_usd, lines_written, turns_to_edit
checkpoints = Bash(vault-cli checkpoints Incomplete)

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

Use `vault-cli checkpoints Incomplete`.

### Creating a checkpoint

Get vault root and project path from `vault-cli config`.
`project_wikilink` is derived from the project context (context.md's `Project note: [[...]]` line).

Path: `{vault_root}/{project_path}/checkpoint-{UTC timestamp}.md`
UTC timestamp: `YYYY-MM-DD-HH-mm-ss` (use `date -u +%Y-%m-%d-%H-%M-%S`)
Template: `{vault_root}/templates/Checkpoint.md`

Frontmatter:

- `type: checkpoint`
- `description` — generate from session context, ask user to confirm or edit
- `done: false` (or `true` if complete)
- `project` — `project_wikilink` from context.md
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
