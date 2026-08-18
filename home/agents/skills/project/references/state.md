# State — report a project's current state

Read-only. Every markdown read goes through `vault-query read`, which resolves an entry name to its path and folds before it unfolds. See Reference: Reading.

## Pseudocode

```
today = Bash(date +%F)

cfg = Bash(vault-query config)            // add --project <name> when the user names a project
if cfg has no project_path: do("no project resolved — surface the error, offer /project setup"), stop
project_path = cfg.project_path

// One call per artifact class — see Reference: Queries
context = Bash(vault-query context)
tracks  = Bash(vault-query tracks --view All --format json)
tickets = Bash(vault-query tickets --view All --format tsv)   // error naming tickets-init = no tickets yet
maps    = Bash(vault-query maps --view All --format json)     // error naming maps-init = no maps yet

// Classify — see Reference: Thresholds
for each track, map, ticket: bucket by status, then by (today - updated)
ready, blocked = partition(open tickets, over their Requires edges)   // see Reference: Blocked and ready

// Charting frontier — one call per open map — see Reference: Maps and the frontier
for each open map:
    frontier = Bash(vault-query tickets --view Open --track <map slug>
                    --kind decision,fact,feasibility --format tsv)

// Scratchpad — fold, then unfold once if it is small enough
shape = Bash(vault-query read <project_path>/Scratchpad.md)
if shape errors (no such file):
    seeds = none
elif shape reports <= 4000 tokens:
    seeds   = Bash(vault-query read <project_path>/Scratchpad.md 0)
    orphans = do("seeds naming a track whose status is now done or abandoned")
else:
    do("report the scratchpad's size and updated date, skip the orphan check, offer to unfold")

do("present the report — see Reference: Report")
do("offer routes — see Reference: Routes")
```

## Reference

### Resolving the project

`vault-query` walks up from cwd to find `<repo>/.vault.config.json`. Check the resolution first, before spending the other calls.

`vault-query config` always exits 0 and always prints `vault_root` and `projects_path`. It prints `project_path` **only** when a project resolved:

```json
{
  "project_path": "/Users/vadim/Documents/vault/41 projects/nix",
  "projects_path": "41 projects",
  "vault_root": "/Users/vadim/Documents/vault"
}
```

An absent `project_path` is the signal that no project resolved. The project-scoped commands (`context`, `tracks`, `tickets`) then exit 1 with:

```
Error: no project resolved (use --project <name> or add .vault.config.json)
```

Surface that message verbatim. Never guess a project name. Offer `/project setup` to wire the repo.

When the user names a project, pass `--project <name>` to every `vault-query` call in the run, `config` included. Build absolute paths from the `project_path` it then prints.

### Thresholds

Age counts days from frontmatter `updated` to today. Only live statuses age.

| Artifact     | Status | Stale after | Ages |
| ------------ | ------ | ----------- | ---- |
| track        | open   | 14 days     | yes |
| track        | paused | —           | no |
| map          | open   | 21 days     | yes |
| ticket       | open   | 30 days     | yes |
| `Scratchpad` | —      | 60 days     | yes |

A paused track never goes stale. The pause is a decision, so ageing it would flag every parked track forever. List paused tracks under **Parked** instead.

Items with status `done`, `abandoned`, or `superseded` stay out of the report. They enter the header tally only.

### Queries

Each row is one call. Run them together.

| What       | Command                                         | Returns                                                                           | Empty case |
| ---------- | ----------------------------------------------- | --------------------------------------------------------------------------------- | ---------- |
| framing    | `vault-query context`                           | the project's `Context.md`                                                        | missing file → say so, offer `/project setup` |
| tracks     | `vault-query tracks --view All --format json`   | one object per track: `Track`, `Status`, `Description`, `Updated`                 | `[]` |
| tickets    | `vault-query tickets --view All --format tsv`   | `Ticket`, `Status`, `Track`, `Requires`, `Description`, `Created`, `Updated`      | exit 1, `Error: no Tickets.base at … (run` `vault-query tickets-init` `)` → no tickets filed yet, not a failure |
| maps       | `vault-query maps --view All --format json`     | one object per map: `Map`, `Status`, `Ordering`, `Crux`, `Description`, `Updated` | exit 1 naming `maps-init` → no maps base; `[]` → a base with no maps |
| scratchpad | `vault-query read <project_path>/Scratchpad.md` | folded overview with a token count                                                | error → no scratchpad |

`tickets --view All` is the only ticket call the report needs. It carries `Status` and `Requires` in one table, which is what the blocked/ready partition reads. Skip the `Open` and `Backlog` views: a backlog ticket is just a row whose `Track` cell is empty.

### Maps and the frontier

`maps` reads `Maps.base`, the same way `tracks` reads `Tracks.base`. So a map row comes from a declared view, never from a directory glob:

```bash
vault-query maps --view All --format json
```

Two columns are a map's own, with no track analogue. `Ordering` says whether the map resolves its highest-risk node first (`risk`) or its leaves first (`dependency`). `Crux` names the one node a risk-ordered map turns on. Report both — a risk-ordered map whose crux is unresolved is the project's real blocker, however fresh its `updated` looks.

A project whose first map has yet to be charted has no base. `maps` then exits 1 naming `maps-init`, the same shape `tickets` uses. Treat that as "no maps", not as an error to report. A base that exists with no maps in it returns `[]`.

**The frontier is a ticket query, not a map query.** A map's nodes are tickets — they carry `kind` and a `track:` backref, and they live in `Tickets.base`. No view of `Maps.base` can reach them. A map pairs 1:1 with `track-<slug>.md` by the shared slug, so ask the ticket base for that slug:

```bash
vault-query tickets --view Open --track <slug> --kind decision,fact,feasibility --format tsv
```

`--track` and `--kind` AND together, so this returns exactly the map's unresolved charting nodes. Rows mean the map still needs deciding. No rows mean it is charted, and its remaining `execution` tickets are ready to hand off — which is the distinction the Active block reports.

Two traps in that query:

- A ticket carrying no `kind:` matches no `--kind` query, so it never lands in either bucket. It is untyped work, not execution work. Surface it separately rather than reading its absence as "nothing left to decide".
- `--kind` rejects a name outside `decision`, `fact`, `feasibility`, `execution`, but a valid kind with no tickets is a truthful empty result. So an error means a typo, and an empty table means an answer.

### Blocked and ready

An open ticket is **ready** when every ticket named in its `Requires` cell has status `done`. It is **blocked** otherwise. Nothing computes this, so compute it from the `All` view.

Match by name: pull every `ticket-…` name out of the `Requires` cell, then look each up in the `Ticket` column. Match on the name rather than a separator, because the base renders a list-valued field itself. The authoritative form is the file's own frontmatter, a YAML list of wikilinks:

```yaml
requires: ["[[41 projects/<project>/ticket-<slug>]]"]
```

Read it with `vault-query read <path> fm` when a cell is ambiguous.

A required name absent from the `Ticket` column is a dangling edge. Report it, and point at `vault-query lint --rule dangling-requires-target=error`.

### Report

Lead with the conclusion. Present these blocks in order, and drop any that is empty except **Active**. Keep the whole report near 40 lines — it is an overview, so summarise and offer detail on request.

1. **Header** — one line. The project, its `result` from `Context.md`, and the tally: `4 open tracks · 2 open maps · 28 open tickets · 12 seeds`.
2. **Active** — open tracks and open maps inside their threshold, freshest first. One line each: name, days idle, description clipped to one clause. Nothing active is itself the finding, so say so.
3. **Stale** — items past their threshold, oldest first. One line each: name, days idle, and the smallest action that would resolve it.
4. **Parked** — paused tracks. Name, and the date the pause was recorded.
5. **Tickets** — the ready and blocked counts, then the ready ones grouped by owning track. Tickets with an empty `Track` cell are the project backlog, so keep them a separate group. Name a blocked ticket only alongside what blocks it.
6. **Scratchpad** — entry count, days since `updated`, and any seed naming a track that is now done or abandoned. An orphaned seed is either finished work or a ticket waiting to be filed.

A seed naming a track this project does not hold is usually a cross-project reference, not an orphan. Seeds are re-filed between projects, and they keep naming the track that raised them. So report a missing track as unresolved, and leave it alone.

State each age in days idle, not as a date. The reader wants the gap, not the timestamp.

### Routes

The skill writes nothing. Close the report with the routes its findings imply, naming the specific artifact each one targets.

| Finding                                      | Route |
| -------------------------------------------- | ----- |
| a track worth resuming                       | `/track` |
| a map with an unresolved frontier            | `/map` |
| a ready ticket to start                      | open it, or `/work <ticket>` |
| a seed that now has a done-condition         | `/vault ticket` |
| a stale open track that is actually finished | `/track save`, then set its `status` |
| a project with no `Tickets.base`             | `vault-query tickets-init` |
| a project with no `Maps.base`                | `vault-query maps-init` |
| an open ticket carrying no `kind:`           | `/vault ticket` — type it, so a frontier query can see it |
| a dangling `requires` edge                   | `/vault lint` |
| someone who needs the state reported outward | `/brief` |

### Reading

Read every markdown file through a structured reader: `vault-query read` inside the vault, `mdread` outside it. Both fold first — frontmatter fields, the section tree, per-section line and token counts — then unfold one address on request. `vault-query read` also resolves an entry name to its path, so `vault-query read "track-mdstruct" Direction` needs no path lookup.

Never `Read` or `cat` a vault file whole, and never `rg`/`fd` the vault: both honor `.gitignore`, which excludes it, so they return nothing and the miss looks like an empty result.

The fold is what makes the overview affordable. `track-mdstruct` runs 104k on disk; its fold is a few dozen lines. So size never decides whether to open a file — it decides which address to unfold.

This report unfolds almost nothing, because the three bases already answer it. `Tracks.base`, `Tickets.base`, and `Maps.base` carry status, description, and `updated` for every row. Unfold a track only when the user drills into one, and then by address (`Direction`, the highest Log entry) — that is `/track`'s job, and the route hands off to it.

The `Scratchpad` is the one artifact whose body **is** its state, so the overview unfolds it. That is the ordinary fold-then-unfold path, not an exception to it. The 4000-token bound only decides whether to pay for the unfold up front or offer it.
