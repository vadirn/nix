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
    shape = Bash(vault-query read <track_path>)                    // folded overview: sections + line/token counts; each Log entry gets its own sub-address under Log
    snapshot = Bash(vault-query read <track_path> Direction)       // Direction — the stable framing
    latest = Bash(vault-query read <track_path> <highest Log sub-address read off the shape>)   // the newest Log entry — the current snapshot
    open_tickets = Bash(vault-query tickets --track <slug> --status open --format text)   // what this track owns; empty stdout = none owned
    backlog_tickets = Bash(vault-query tickets --backlog --format text)                   // open tickets in the project backlog, owned by no track; empty stdout = none unowned
    do("present Direction + latest Log entry + open tickets (owned) + backlog tickets (unowned) as the resume snapshot, keeping the two lists distinct; offer to unfold Decisions / older Log entries by address on demand")

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

vault-query resolves the project from the current working directory by walking up to find `<repo>/.vault.config.json`. If cwd isn't inside a project, vault-query errors with `no project resolved (use --project <name> or add .vault.config.json)`. Surface that error verbatim — report it as-is without synthesizing a project name.

`vault-query config` prints JSON with `vault_root` and `project_path`. Use `project_path` to build absolute file paths.

### Presenting a track

Get the shape first, unfold on demand — a mature track runs hundreds of lines / tens of thousands of tokens, so reading the whole body every resume is wasteful. `vault-query read <track_path>` (no address) prints a folded overview: the frontmatter fields, every top-level section with its line and estimated-token counts, and each Log entry addressed individually as a sub-address under Log (`<Log's own number>.N`). From that map:

- **Snapshot** = Direction (address `Direction`) + the highest-numbered Log entry (`vault-query read <track_path> <its sub-address>`). The latest Log entry is the current state; Direction is the stable framing. Present these two.
- **On demand** — unfold Decisions (address `Decisions`), an older Log entry, or any section by its address (`vault-query read <track_path> <addr>`), or Read an exact line range from the overview's line numbers. Decisions is append-only: when the user goes deeper into it, unfold the whole section and treat every item as current. Glossary and Files of interest are stable — reach for them only when a term or path needs resolving.

Address sections by heading slug (`Direction`, `Decisions`, `Log`), not by position: a slug survives sections being added or removed, a positional number does not. Only Log entries need a positional sub-address, and the overview prints each one, so read it off the map rather than assuming a fixed section number.

`vault-query read` is the vault-facing wrapper over `mdread`, so the address scheme (`0`/`text`, section numbers, sub-addresses, heading slugs, `fm[.path]`, `links`) and the `--depth`/`--threshold`/`--full` controls are the same ones `mdread` applies to any markdown file outside the vault.

### Open tickets for the track and the backlog

The work a track still owes lives in tickets, not in the track file, and a track's remaining work can sit in two places: tickets it owns, and tickets no track owns yet in the project backlog (a ticket's `track:` field is empty until a track takes it — that emptiness is the design, not a gap). Ownership marks where a ticket belongs, not that work on it has started, so a track's list mixes what is underway with what is queued.

Run both queries on resume:

- `vault-query tickets --track <slug> --status open --format text` — `<slug>` is the track's slug (file name minus the `track-` prefix). Prints one line per ticket this track owns. Exit 0 with empty stdout means the track owns no open tickets — say so rather than inventing one, but check the backlog query below before reporting nothing is left.
- `vault-query tickets --backlog --format text` — open tickets across the project with no track owning them yet (the filter already implies `--status open`; pairing it with `--status` is redundant). Exit 0 with empty stdout means nothing is left unowned.

Both print the same line shape, no header:

```
ticket-slug — One-sentence description copied from the ticket's frontmatter. (status: open) (track: work-tracking-model) (41 projects/nix/ticket-ticket-slug.md)
```

Line shape: `<slug> — <description> (status: <status>) [(track: <slug>)] [(requires: <slug>)] (<vault-relative path>)`. The `(track: …)` and `(requires: …)` fields appear only when set; `requires:` names a ticket that must land first, so a ticket is blocked while any entry's ticket is still open — nothing computes that, so check the named ticket's status yourself. Backlog lines have no `(track: …)` field, since none is set.

Present the two lists with the snapshot, kept distinct (owned vs. unowned), and unfold a ticket's own body with `vault-query read <ticket path>` when the user picks one to work on.
