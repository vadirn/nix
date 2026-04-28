# Save — write a track entry

## Pseudocode

```
root = Bash("git rev-parse --show-toplevel 2>/dev/null || pwd")
tracks_dir = root + "/.tracks"
today = Bash("date +%Y-%m-%d")

files = Bash("ls " + tracks_dir + "/track-*.md 2>/dev/null || true") split by line
active = []
for f in files filter non-empty:
    fm = parse_frontmatter(Read(f, limit=20))
    if fm.status in {"done", "closed", "archived"}:
        continue
    slug = basename(f) without "track-" prefix and ".md" suffix
    active.append({ path: f, slug: slug, status: fm.status, description: fm.description, updated: fm.updated })
active.sort by updated DESC

options = [for t in active: { label: "track-" + t.slug, description: t.status + " · " + t.description }] + [{ label: "new", description: "create a new track" }]
selected = AskUserQuestion(options, singleSelect=true)

if selected == "new":
    Bash("mkdir -p " + tracks_dir)
    suggested_slug = do("derive slug from session topic, kebab-case, no leading 'track-'")
    slug = AskUserQuestion("slug?", default=suggested_slug)
    description = AskUserQuestion("one-line description?")
    template = Read(<skill_dir>/assets/track-template.md)
    body = template
        .replace("__SLUG__", slug)
        .replace("__DESCRIPTION__", description)
        .replace_all("__DATE__", today)
    track_path = tracks_dir + "/track-" + slug + ".md"
    Bash("write atomically: write body to <track_path>.tmp, then mv <track_path>.tmp <track_path>")
    do("ask user to fill ## Direction now or defer")

else:
    track_path = active where slug matches selected → path
    track = Read(track_path)
    last_n = do("scan ## Log section for '### N. YYYY-MM-DD — title' headings; take max N; default 0 if none")
    new_entry_number = last_n + 1
    title = do("draft a short title for this session's work")
    narrative = do("draft narrative paragraph: outcomes a fresh agent would need; exclude process, exploration noise, content with a permanent home elsewhere")

    proposed_edits = {
      decisions:  do("session decisions to append as numbered items, or [] if none"),
      backlog:    do("new backlog items to append as `[ ] (N). ...`; resolved items to mark `[x]` in place — NEVER delete or renumber"),
      log_entry:  "### " + new_entry_number + ". " + today + " — " + title + "\n\n" + narrative,
      updated:    today,
    }

    AskUserQuestion("apply these edits to <track_path>?", show=proposed_edits)
    if approved:
        do("compose updated body: append decisions to ## Decisions, apply backlog edits to ## Backlog, append log_entry to ## Log, set frontmatter updated:")
        Bash("write atomically: write new body to <track_path>.tmp, then mv <track_path>.tmp <track_path>")

graduation:
    do("review session for skill / instruction candidates worth promoting elsewhere; present as suggestions, let user decide")
    do("suggest /clear")
```

## Reference

### Resolving repo root and template

`git rev-parse --show-toplevel` returns the working tree root; fall back to `pwd` outside a git repo.
Tracks live in `<root>/.tracks/`. The template ships inside this skill at `assets/track-template.md` —
read it relative to the skill base directory (the directory containing `SKILL.md`), not via any external
config. Substitute `__SLUG__`, `__DESCRIPTION__`, and `__DATE__` (replace all) before writing.

### Atomic write

A partial write to a track file leaves the rolling history corrupted. Make saves crash-safe by writing
to a sibling temp file and renaming it over the target:
`printf %s "$content" > "$path.tmp" && mv "$path.tmp" "$path"`. The Write tool does not do this; use
Bash with `mv`.

### Empty-result handling

If `.tracks/` does not exist or contains no `track-*.md`, the picker becomes "new" only. `mkdir -p` the
directory at the moment of creation, never on the read path.

### Slug rules

Kebab-case, no spaces, no leading `track-` (the prefix is added when forming the file name). Avoid
characters that are awkward in file paths (`/`, `:`, `?`, `*`). The slug becomes the file name
(`track-<slug>.md`) and the frontmatter `slug:` field — keep them in sync.

### Log entry format

Sub-heading `### N. YYYY-MM-DD — <title>`, where `N` increments monotonically across the track's
lifetime. Numbers are never reused — even if an entry is later edited or removed, its number stays
consumed. To find the next number, grep for `^### ([0-9]+)\.` in the `## Log` section, take the max,
add one.

`<title>` is a short noun phrase summarizing the session's outcome (e.g. `entry-binding decision`,
`format refinement`).

### Backlog conventions

- Numbered, append-only.
- Resolved items get `[x]` marked in place — never delete, never renumber.
- New items get appended as `[ ] (N). <text>` where N is the next available integer (length of list + 1).
  The parentheses prevent Markdown renderers (notably Obsidian) from re-numbering the line as an
  ordered-list item.

### Decisions conventions

Numbered, append-only. Each decision: a short title, then the rationale. Never delete; if reversed,
append a new decision that supersedes the prior one and reference it by number.

### Frontmatter parsing and rewrite

Read the first 20 lines to parse the leading `---`-delimited block. Fields used: `slug`, `description`,
`status`, `updated`. When saving, only the `updated:` line changes. Rewrite by string replacement on
that single line; do not regenerate the whole frontmatter — preserve unknown fields the user may have
added.

### Importance filter for the Log narrative

Include in the Log entry:
- Outcomes a fresh agent would need to continue the work.
- Decisions made (also written to ## Decisions, but the Log captures *why now*).
- Frictions encountered that aren't yet resolved (route to ## Backlog if actionable).

Exclude:
- Process noise ("we discussed", "we tried X then Y") unless the path itself is the lesson.
- Stylistic exploration that didn't change the outcome.
- Content with a permanent home elsewhere (link to it instead).
