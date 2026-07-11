# Read — resume a track

## Pseudocode

```
results = Bash(vault-query tracks --view Active --format json)

if results is empty (parsed JSON is []):
    do("tell user: no Active tracks in this project; suggest /track save to create one")
else:
    if results has one row:
        cfg = Bash(vault-query config)
        track_path = <cfg.project_path>/<row.Track>.md
    else:
        options = [for r in results: { label: r.Track, description: r.Status + " · updated " + r.Updated + " · " + r.Description }]
        selected = AskUserQuestion(options, singleSelect=true)
        cfg = Bash(vault-query config)
        track_path = <cfg.project_path>/<selected.Track>.md

    // Shape first, then unfold — tracks grow large; do NOT Read the whole body (see Reference: Presenting a track)
    shape = Bash(vault-query read <track_path>)                    // folded overview: sections + line/token counts; each Log entry addressed 6.N
    snapshot = Bash(vault-query read <track_path> 1)               // Direction — the stable framing
    latest = Bash(vault-query read <track_path> <highest 6.N>)     // the newest Log entry — the current snapshot
    do("present Direction + latest Log entry as the resume snapshot; offer to unfold Decisions / Backlog / older Log entries by address on demand")

    query = do("derive a short phrase from the track's Direction and description — the topic the user is working on")
    grounding = Bash(vault-query consult "<query>" --format markdown)
    if grounding exit code == 0:
        do("fold the returned vault slices into the presentation as 'Related prior thinking' before asking what to do")
    // exit code 4 = confident silence; 1 or 2 = error — present nothing extra in both cases

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
Surface that error verbatim — report it as-is without synthesizing a project name.

`vault-query config` prints JSON with `vault_root` and `project_path`. Use `project_path` to build absolute file paths.

### Presenting a track

Get the shape first, unfold on demand — a mature track runs hundreds of lines / tens of thousands of tokens, so
reading the whole body every resume is wasteful. `vault-query read <track_path>` (no address) prints a folded
overview: the frontmatter fields, every top-level section with its line and estimated-token counts, and each Log
entry addressed individually as `6.N`. From that map:

- **Snapshot** = Direction (address `1`) + the highest-numbered Log entry (`vault-query read <track_path> <6.N>`).
  The latest Log entry is the current state; Direction is the stable framing. Present these two.
- **On demand** — unfold Decisions (`4`), Backlog (`5`), an older Log entry, or any section by its address
  (`vault-query read <track_path> <addr>`), or Read an exact line range from the overview's line numbers. Decisions
  and Backlog are append-only: when the user goes deeper into either, unfold the whole section and treat every item
  as current. Glossary and Files of interest are stable — reach for them only when a term or path needs resolving.

`vault-query read` is mdstruct-backed (the same progressive-unfolding reader the `read` command exposes), so the
address scheme (`0`/`text`, `1`, `6.N`, heading slugs) and the `--depth`/`--threshold`/`--full` controls all apply here.
