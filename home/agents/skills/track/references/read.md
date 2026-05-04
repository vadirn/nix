# Read — resume a track

## Pseudocode

```
results = Bash(vault-query tracks --view Active --format json)

if results is empty (parsed JSON is []):
    do("tell user: no Active tracks in this project; suggest /track save to create one")
elif results has one row:
    cfg = Bash(vault-query config)
    track_path = <cfg.project_path>/<row.Track>.md
    do("Read(track_path), present the full body")
else:
    options = [for r in results: { label: r.Track, description: r.Status + " · updated " + r.Updated + " · " + r.Description }]
    selected = AskUserQuestion(options, singleSelect=true)
    cfg = Bash(vault-query config)
    track_path = <cfg.project_path>/<selected.Track>.md
    do("Read(track_path), present the full body")

ask "what should we do with this track?"
```

## Reference

### vault-query JSON output

`vault-query tracks --view Active --format json` returns one object per row, keyed by display name:

| Key           | Source                           |
| ------------- | -------------------------------- |
| `Track`       | File name (without `.md`)        |
| `Status`      | Frontmatter `status`             |
| `Description` | Frontmatter `description`        |
| `Updated`     | Frontmatter `updated` (ISO date) |

Rows are already sorted by `updated` DESC.

The slug is the file name with the `track-` prefix removed: `track-checkpoint-redesign` → slug `checkpoint-redesign`.

### Empty result handling

When no rows match, vault-query exits 0 and prints `[]`. Parse the JSON and branch on `results.length == 0`.

### Resolving the project

vault-query resolves the project from the current working directory by walking up to find `<repo>/.vault.config.json`.
If cwd isn't inside a project, vault-query errors with `no project resolved (use --project <name> or add .vault.config.json)`.
Surface that error verbatim — do not synthesize a project name.

`vault-query config` prints JSON with `vault_root` and `project_path`. Use `project_path` to build absolute file paths.

### Presenting a track

Read the whole body. The latest Log entry (highest `### N.` heading) is the current snapshot. Direction, Glossary,
and Files of interest are stable across sessions. Decisions and Backlog are append-only — read all entries; don't
treat older items as stale.
