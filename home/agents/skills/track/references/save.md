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
    do("instantiate template: set frontmatter per ### Frontmatter;
        leave Direction empty for the user to fill, leave Glossary baseline intact,
        keep Files of interest / Decisions / Backlog / Log empty")
    Bash("write atomically: write content to <track_path>.tmp, then mv <track_path>.tmp <track_path>")

    grounding = Bash(vault-query consult "<description>" --format markdown)
    if grounding exit code == 0:
        do("present the returned vault slices as 'Related prior thinking' to inform the new track's direction")
    // exit code 4 = confident silence; 1 or 2 = error — present nothing extra in both cases

    do("ask user to fill ## Direction now or defer")

else:
    track_path = <cfg.project_path>/<selected.Track>.md
    // Shape first — a mature track is large; do NOT Read the whole body (see Reference: Editing a large track)
    shape = Bash(vault-query read <track_path>)   // overview: section line-map + each Log entry addressed 6.N
    last_n = do("read the highest Log address 6.N from the shape; default 0 if no Log entries")
    new_entry_number = last_n + 1
    title = do("draft a short title for this session's work")
    narrative = do("draft narrative paragraph: outcomes a fresh agent would need; exclude process, exploration noise, content with a permanent home elsewhere")

    proposed_edits = {
      decisions:  do("session decisions to append as numbered items, or [] if none; if any existing decision was reversed or overridden this session, also wrap its title and rationale in ~~strike-through~~ in place and reference it from the new superseding decision"),
      backlog:    do("new backlog items to append as `- [ ] (N). ...`; resolved items to mark `[x]` in place — keep all items; preserve all numbers"),
      glossary:   do("new domain terms surfaced this session, appended as un-pinned table rows; preserve all existing rows, especially pinned (bolded-Term) rows"),
      log_entry:  "### " + new_entry_number + ". " + <today> + " — " + title + "\n\n" + narrative,
      updated:    <today>,
    }

    AskUserQuestion("apply these edits to <track_path>?", show=proposed_edits)
    if approved:
        do("apply as localized Edits, not a full-body rewrite (see Reference: Editing a large track): for each target section, Read only its line range from the shape to get exact anchors, then Edit in place — append decisions to ## Decisions, apply backlog [x]/append edits to ## Backlog, append rows to ## Glossary, append log_entry to ## Log, set frontmatter updated:")

graduation:
    do("review session for CLAUDE.md / skills / vault candidates; present as suggestions, let user decide")
    do("skip /git commit suggestion — the track is vault content propagated by Obsidian Sync; suggest commit only if changes landed inside `.claude/` or `.scripts/`, or the user explicitly asked")
    do("suggest /clear")
```

## Reference

### Editing a large track

A mature track runs hundreds of lines / tens of thousands of tokens. Never read or rewrite the whole body on save — that is the cost this procedure exists to avoid.

- **Shape, not body.** `vault-query read <track_path>` (no address) prints a folded overview: the frontmatter fields, every top-level section with its start line and estimated tokens, and each Log entry addressed as `6.N`. The last Log number is the highest `6.N` — read it off the overview instead of grepping the body. The overview's line numbers are the map for the next step.
- **Targeted reads.** For each section an edit touches (Decisions, Backlog, Glossary, Log, the frontmatter block), Read only that section's line range (or unfold it with `vault-query read <track_path> <addr>`) to get the exact anchor text an Edit needs. A save touches four or five sections, so a handful of small reads replaces one 30k-token Read.
- **Localized Edits.** Apply the entry as in-place Edits at those anchors — append the log entry under `## Log`, append/append-`[x]` under `## Backlog`, append decisions under `## Decisions`, append Glossary rows, bump `updated:`. Each Edit's write window is a single hunk, smaller than the old full-body rewrite, so the partial-write exposure is lower, not higher.

**Full-file writes stay atomic.** Creating a new track writes a whole file from the template — there is no large body to avoid, and a partial write would leave a corrupt half-track that Obsidian Sync recovers only through a manual UI flow. For that one full-file write, stay crash-safe with a sibling temp file renamed over the target: `printf %s "$content" > "$path.tmp" && mv "$path.tmp" "$path"` (the Write tool does not do this; use Bash with `mv`). Localized Edits into an existing track do not need the temp-file dance.

### Empty-result handling

`vault-query tracks --view Active --format json` exits 0 and prints `[]` when no rows match. Parse the JSON; an empty array means the picker becomes "new" only.

### Frontmatter

Read `templates/Track.md` for structure. Required fields, in order:

- `type` — always `track`
- `slug` — kebab-case, matches the filename suffix (`track-<slug>.md`)
- `description` — 1-sentence summary, the same value shown by the resume picker
- `status` — one of `open` / `paused` / `done` / `abandoned` / `superseded`. Set to `open` on creation.
- `project` — wikilink copied from `<project_path>/context.md` line `Project note: [[...]]`
- `created` — ISO date (`YYYY-MM-DD`). Set on creation; never changed.
- `updated` — ISO date. Bumped to `<today>` on every save.

No other fields. Drop the template's `template: true` line; replace the `status:` multi-value picker list with the chosen single value. Quote any value containing double quotes with single quotes.

### Log entry format

Sub-heading `### N. YYYY-MM-DD — <title>`, where `N` increments monotonically across the track's lifetime. Numbers are never reused — even if an entry is later edited or removed, its number stays consumed. The next number is the highest Log address `6.N` in the `vault-query read` overview plus one (that overview enumerates every Log entry without reading the body); default to 1 when the Log is empty.

`<title>` is a short noun phrase summarizing the session's outcome (e.g. `entry-binding decision`, `format refinement`).

### Backlog conventions

- Backlog entries are deferred work that could seed a future effort's thesis: a durable change with a done-condition, self-contained. Git/session state (unpushed commits, dirty branches, "decide when acting" notes) is not backlog — it belongs in the Log entry, which the next entry supersedes.
- Numbered, append-only.
- Resolved items get `[x]` marked in place — keep all items; preserve all numbers.
- New items get appended as `- [ ] (N). <text>` where N is the next available integer (length of list + 1). The parentheses prevent Obsidian from rendering the leading number as a markdown ordered-list item, which would re-number the line.

### Decisions conventions

Numbered, append-only. Each decision: a short title, then the rationale. Keep all decisions.

When a decision is reversed or overridden:

1. Append a new decision that supersedes the prior one and references it by number (e.g. `supersedes (3)`).
2. In the same edit, wrap the superseded decision's title and rationale in `~~…~~` strike-through so a cold reader sees at a glance that it no longer holds. Keep the number and the text intact — strike-through marks it obsolete without erasing the history.

Surface both the new decision and the strike-through edit in the `proposed_edits` confirmation step.

### Glossary conventions

The Glossary is a 2-column markdown table: `| Term | Definition |`. Two row classes:

- **Pinned rows** — Term is bolded (e.g. **Track**, **Decision**). Keep pinned rows intact: preserve their order, wording, and presence. The template seeds eight pinned rows describing the track's own conventions; they document the format inside every track so a cold reader can understand it without consulting the skill.
- **Un-pinned rows** — project-specific terms accrued during the work. Append-only by default; refining a definition is done by appending a new row with the sharpened wording rather than rewording in place. The old row stays so the history of a term's understanding is recoverable.

Surface every Glossary change in the `proposed_edits` confirmation step. Silent rewrites are the failure mode this section exists to prevent.

### Resolving paths

`vault-query config` prints JSON with `vault_root` and `project_path`. Use these to:

- find `<vault_root>/templates/Track.md`
- find `<project_path>/track-<slug>.md`
- read `<project_path>/context.md` for the project wikilink (`Project note: [[...]]` line)

### Skip /git commit after save

Tracks live in `<vault_root>/41 projects/<project>/track-<slug>.md` — vault content propagated by Obsidian Sync, not git. After a track save, skip the `/git commit` suggestion. Exceptions: changes that landed inside `.claude/` or `.scripts/` (confirm with `git status`), or the user explicitly asked. A `/git commit` prompt after every track save adds friction the user has to dismiss and risks staging files `.gitignore` would refuse anyway. Mirrors the rule in `home/agents/skills/vault/references/post-edit.md`.

### Importance filter for the Log narrative

Include in the Log entry:

- Outcomes a fresh agent would need to continue the work.
- Decisions made (also written to ## Decisions, but the Log captures _why now_).
- Frictions encountered that aren't yet resolved (route to ## Backlog only if they qualify per Backlog conventions).
- Transient session state: unpushed commits, dirty branches, branch composition, pending pushes. The Log entry is a snapshot the next entry supersedes — state that expires belongs here, never in ## Backlog.

Exclude:

- Process noise ("we discussed", "we tried X then Y") unless the path itself is the lesson.
- Stylistic exploration that didn't change the outcome.
- Content with a permanent home elsewhere (link to it instead).
