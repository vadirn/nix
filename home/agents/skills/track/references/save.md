# Save — write a track entry

## Pseudocode

```
active = Bash(vault-query tracks --view Active --format json)  // [] when no rows match

cfg = Bash(vault-query config)             // gives vault_root, project_path
options = [for t in active: { label: t.Track, description: t.Status + " · " + t.Description }] + [{ label: "new", description: "create a new track" }]
selected = AskUserQuestion(options, singleSelect=true)

if selected == "new":
    suggested_slug = do("derive slug from session topic, kebab-case")
    slug = AskUserQuestion("slug?", default=suggested_slug)
    description = AskUserQuestion("one-line description?")
    template = Read(<cfg.vault_root>/templates/Track.md)
    project_wikilink = do("read <cfg.project_path>/context.md and copy 'Project note: [[...]]' wikilink")
    track_path = <cfg.project_path>/track-<slug>.md
    do("instantiate template: set type=track, slug=<slug>, description=<description>, status=open,
        project=<project_wikilink>, created=<today>, updated=<today>;
        leave Direction empty for the user to fill, leave Glossary baseline intact,
        keep Files of interest / Decisions / Backlog / Log empty")
    Bash("write atomically: write content to <track_path>.tmp, then mv <track_path>.tmp <track_path>")
    do("ask user to fill ## Direction now or defer")

else:
    track_path = <cfg.project_path>/<selected.Track>.md
    track = Read(track_path)
    last_n = do("scan ## Log section for '### N. YYYY-MM-DD — title' headings; take max N; default 0 if none")
    new_entry_number = last_n + 1
    title = do("draft a short title for this session's work")
    narrative = do("draft narrative paragraph: outcomes a fresh agent would need; exclude process, exploration noise, content with a permanent home elsewhere")

    proposed_edits = {
      decisions:  do("session decisions to append as numbered items, or [] if none"),
      backlog:    do("new backlog items to append as `[ ] (N). ...`; resolved items to mark `[x]` in place — NEVER delete or renumber"),
      log_entry:  "### " + new_entry_number + ". " + <today> + " — " + title + "\n\n" + narrative,
      updated:    <today>,
    }

    AskUserQuestion("apply these edits to <track_path>?", show=proposed_edits)
    if approved:
        do("compose updated body: append decisions to ## Decisions, apply backlog edits to ## Backlog, append log_entry to ## Log, set frontmatter updated:")
        Bash("write atomically: write new body to <track_path>.tmp, then mv <track_path>.tmp <track_path>")

graduation:
    do("review session for CLAUDE.md / skills / vault candidates; present as suggestions, let user decide")
    do("suggest /clear")
```

## Reference

### Atomic write

Obsidian Sync recovery from a partial write is a manual UI flow. To make a save crash-safe, write to a sibling temp
file and rename it over the target: `printf %s "$content" > "$path.tmp" && mv "$path.tmp" "$path"`. The Write tool
does not do this; use Bash with `mv`.

### Empty-result handling

`vault-query tracks --view Active --format json` exits 0 and prints `[]` when no rows match. Parse the JSON; an
empty array means the picker becomes "new" only.

### Log entry format

Sub-heading `### N. YYYY-MM-DD — <title>`, where `N` increments monotonically across the track's lifetime. Numbers
are never reused — even if an entry is later edited or removed, its number stays consumed. To find the next number,
grep for `^### ([0-9]+)\.` in the `## Log` section, take the max, add one.

`<title>` is a short noun phrase summarizing the session's outcome (e.g. `entry-binding decision`, `format refinement`).

### Backlog conventions

- Numbered, append-only.
- Resolved items get `[x]` marked in place — never delete, never renumber.
- New items get appended as `[ ] (N). <text>` where N is the next available integer (length of list + 1). The parentheses prevent Obsidian from rendering the leading number as a markdown ordered-list item, which would re-number the line.

### Decisions conventions

Numbered, append-only. Each decision: a short title, then the rationale. Never delete; if reversed, append a new
decision that supersedes the prior one and reference it.

### Resolving paths

`vault-query config` prints JSON with `vault_root` and `project_path`. Use these to:
- find `<vault_root>/templates/Track.md`
- find `<project_path>/track-<slug>.md`
- read `<project_path>/context.md` for the project wikilink (`Project note: [[...]]` line)

### Importance filter for the Log narrative

Include in the Log entry:
- Outcomes a fresh agent would need to continue the work.
- Decisions made (also written to ## Decisions, but the Log captures *why now*).
- Frictions encountered that aren't yet resolved (route to ## Backlog if actionable).

Exclude:
- Process noise ("we discussed", "we tried X then Y") unless the path itself is the lesson.
- Stylistic exploration that didn't change the outcome.
- Content with a permanent home elsewhere (link to it instead).
