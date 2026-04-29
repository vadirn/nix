# Read — resume a track

## Pseudocode

```
root = Bash("git rev-parse --show-toplevel 2>/dev/null || pwd")
tracks_dir = root + "/.tracks"

files = Bash("ls " + tracks_dir + "/track-*.md 2>/dev/null || true") split by line
files = files filter non-empty

if files is empty:
    do("tell user: no tracks found in <tracks_dir>; suggest /track save to create one")
    return

active = []
for f in files:
    fm = parse_frontmatter(Read(f, limit=20))
    if fm.status in {"done", "closed", "archived"}:
        continue
    slug = basename(f) without "track-" prefix and ".md" suffix
    active.append({ path: f, slug: slug, status: fm.status, description: fm.description, updated: fm.updated })

active.sort by updated DESC

if active is empty:
    do("tell user: every track in <tracks_dir> is closed/archived; suggest /track save to create one")
    return

if length(active) == 1:
    track = active[0]
    do("Read(track.path), present the full body")
else:
    options = [for t in active: { label: "track-" + t.slug, description: t.status + " · updated " + t.updated + " · " + t.description }]
    selected = AskUserQuestion(options, singleSelect=true)
    track = active where slug matches selected
    do("Read(track.path), present the full body")

ask "what should we do with this track?"
```

## Reference

### Resolving repo root

`git rev-parse --show-toplevel` returns the absolute path of the working tree root. Outside a git repo it
exits non-zero; fall back to `pwd`. Tracks live in `<root>/.tracks/`. Stay inside the resolved repo root —
each repo carries its own `.tracks/`.

### Frontmatter parsing

The frontmatter block is the leading `---`-delimited region. Read the first 20 lines of the file (the
template body never pushes frontmatter past line 10). Parse simple `key: value` lines; ignore quotes.
Fields used: `slug`, `description`, `status`, `updated`. A missing `status` field counts as Active.

### Active filter

A track is Active when `status` is not one of `done`, `closed`, `archived`. The intent matches the
vault-coupled skill's Active view: anything still in motion. Treat unknown statuses (e.g. `paused`,
`waiting`) as Active — surface them in the picker so the user decides.

### Empty state

If `.tracks/` does not exist, or contains no `track-*.md` files, tell the user and offer `/track save`
to create the first one. Leave directory creation to the save path.

### Presenting a track

Read the whole body. The latest Log entry (highest `### N.` heading) is the current snapshot. Direction,
Glossary, and Files of interest are stable across sessions. Decisions and Backlog are append-only — read
all entries; treat older items as still in force.
