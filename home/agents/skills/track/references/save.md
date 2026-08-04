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
    project_wikilink = do("read <cfg.project_path>/Context.md and copy 'Project note: [[...]]' wikilink")
    track_path = <cfg.project_path>/track-<slug>.md
    do("instantiate template: set frontmatter per ### Frontmatter;
        leave Direction empty for the user to fill, leave Glossary baseline intact,
        keep Files of interest / Decisions / Log empty")
    Bash("write atomically: write content to <track_path>.tmp, then mv <track_path>.tmp <track_path>")

    grounding = Bash(vault-query consult "<description>" --format markdown)
    if grounding exit code == 0:
        do("present the returned vault slices as 'Related prior thinking' to inform the new track's direction")
    // exit code 4 = confident silence; 1 or 2 = error — present nothing extra in both cases

    do("ask user to fill ## Direction now or defer")

else:
    track_path = <cfg.project_path>/<selected.Track>.md
    // Shape first — a mature track is large; do NOT Read the whole body (see Reference: Editing a large track)
    shape = Bash(vault-query read <track_path>)   // overview: section line-map + each Log entry given its own sub-address under Log
    last_n = do("read the highest Log sub-address off the shape; default 0 if no Log entries")
    new_entry_number = last_n + 1
    title = do("draft a short title for this session's work")
    narrative = do("draft narrative paragraph: outcomes a fresh agent would need; exclude process, exploration noise, content with a permanent home elsewhere")

    proposed_edits = {
      decisions:  do("session decisions to append as numbered items, or [] if none; if any existing decision was reversed or overridden this session, also wrap its title and rationale in ~~strike-through~~ in place and reference it from the new superseding decision"),
      glossary:   do("new domain terms surfaced this session, appended as un-pinned table rows; preserve all existing rows, especially pinned (bolded-Term) rows"),
      log_entry:  "### " + new_entry_number + ". " + <today> + " — " + title + "\n\n" + narrative,
      updated:    <today>,
    }

    AskUserQuestion("apply these edits to <track_path>?", show=proposed_edits)
    if approved:
        do("apply as localized Edits, not a full-body rewrite (see Reference: Editing a large track): for each target section, Read only its line range from the shape to get exact anchors, then Edit in place — append decisions to ## Decisions, append rows to ## Glossary, append log_entry to ## Log, set frontmatter updated:")

graduation:
    do("sweep the session for durable facts left unrouted; route each by `## Filing` in AGENTS.md, present as suggestions, let user decide (see Reference: Filing backstop)")
    do("skip /git commit suggestion — the track is vault content propagated by Obsidian Sync; suggest commit only if changes landed inside `.claude/` or `.scripts/`, or the user explicitly asked")
    do("suggest /clear")
```

## Reference

### Editing a large track

A mature track runs hundreds of lines / tens of thousands of tokens. Never read or rewrite the whole body on save. That is the cost this procedure exists to avoid.

- **Shape, not body.** `vault-query read <track_path>` (no address) prints a folded overview: the frontmatter fields, every top-level section with its start line and estimated tokens, and each Log entry addressed as a sub-address under Log. The last Log number is the highest of those sub-addresses. Read it off the overview instead of grepping the body, and take Log's own section number from the overview too rather than assuming a fixed position. The overview's line numbers are the map for the next step.
- **Targeted reads.** For each section an edit touches (Decisions, Glossary, Log, the frontmatter block), Read only that section's line range (or unfold it with `vault-query read <track_path> <addr>`, addressing by heading slug) to get the exact anchor text an Edit needs. A save touches three or four sections.
- **Localized Edits.** Apply the entry as in-place Edits at those anchors — append the log entry under `## Log`, append decisions under `## Decisions`, append Glossary rows, bump `updated:`.

**Full-file writes stay atomic.** Creating a new track writes a whole file from the template. There is no large body to avoid, and a partial write would leave a corrupt half-track that Obsidian Sync recovers only through a manual UI flow. For that one full-file write, stay crash-safe with a sibling temp file renamed over the target: `printf %s "$content" > "$path.tmp" && mv "$path.tmp" "$path"` (the Write tool does not do this; use Bash with `mv`). Localized Edits into an existing track do not need the temp-file dance.

### Empty-result handling

`vault-query tracks --view Active --format json` exits 0 and prints `[]` when no rows match. Parse the JSON. An empty array means the picker becomes "new" only.

### Frontmatter

Read `templates/Track.md` for structure. Required fields, in order:

- `type` — always `track`
- `slug` — kebab-case, matches the filename suffix (`track-<slug>.md`)
- `description` — 1-sentence summary, the same value shown by the resume picker
- `status` — one of `open` / `paused` / `done` / `abandoned` / `superseded`. Set to `open` on creation.
- `project` — wikilink copied from `<project_path>/Context.md` line `Project note: [[...]]`
- `created` — ISO date (`YYYY-MM-DD`). Set on creation; never changed.
- `updated` — ISO date. Bumped to `<today>` on every save.

No other fields. Drop the template's `template: true` line. Replace the `status:` multi-value picker list with the chosen single value. Quote any value containing double quotes with single quotes.

### Log entry format

Sub-heading `### N. YYYY-MM-DD — <title>`, where `N` increments monotonically across the track's lifetime. Numbers are never reused. Even if an entry is later edited or removed, its number stays consumed. The next number is the highest Log sub-address in the `vault-query read` overview plus one (that overview enumerates every Log entry without reading the body). Default to 1 when the Log is empty.

`<title>` is a short noun phrase summarizing the session's outcome (e.g. `entry-binding decision`, `format refinement`).

**Cite the work by the paths and symbols it touched, plus the PR number once one exists (`#96`).** These referents survive rebase and squash-merge, and the commit stays recoverable from them (`git log --follow <path>`, `git log -S <symbol>`). With no PR yet, paths alone carry the entry.

### Decisions conventions

Numbered, append-only. Each decision: a short title, then the rationale. Keep all decisions.

When a decision is reversed or overridden:

1. Append a new decision that supersedes the prior one and references it by number (e.g. `supersedes (3)`).
2. In the same edit, wrap the superseded decision's title and rationale in `~~…~~` strike-through so a cold reader sees at a glance that it no longer holds. Keep the number and the text intact. Strike-through marks it obsolete without erasing the history.

Surface both the new decision and the strike-through edit in the `proposed_edits` confirmation step.

### Glossary conventions

The Glossary is a 2-column markdown table: `| Term | Definition |`. Two row classes:

- **Pinned rows** — Term is bolded (e.g. **Track**, **Decision**). Keep pinned rows intact: preserve their order, wording, and presence. The template seeds seven pinned rows describing the track's own conventions. They document the format inside every track so a cold reader can understand it without consulting the skill.
- **Un-pinned rows** — project-specific terms accrued during the work. Append-only by default. Refine a definition by appending a new row with the sharpened wording rather than rewording in place. The old row stays so the history of a term's understanding is recoverable.

Surface every Glossary change in the `proposed_edits` confirmation step. Silent rewrites are the failure mode this section exists to prevent.

### Resolving paths

`vault-query config` prints JSON with `vault_root` and `project_path`. Use these to:

- find `<vault_root>/templates/Track.md`
- find `<project_path>/track-<slug>.md`
- read `<project_path>/Context.md` for the project wikilink (`Project note: [[...]]` line)

### Filing backstop

`## Filing` in `home/agents/AGENTS.md` is ambient and always loaded. It catches a durable fact the moment it surfaces mid-session. It names the typed destination each kind takes: the project's `Context.md`, a vault card, a vault note, a ticket, the project's `Scratchpad.md`, a repository's own `CLAUDE.md` or `AGENTS.md`. Read the routes there. One copy stays authoritative.

This step is the backstop, not the sole catcher. It sweeps up whatever the session surfaced and left unrouted, so a candidate that went unproposed at the time still reaches its home at the save.

The sweep presents each candidate as a suggestion — what it is, which destination takes it, a one-line summary — and the user decides. The write itself follows the route `## Filing` names, after approval.

### Skip /git commit after save

Tracks live in `<vault_root>/41 projects/<project>/track-<slug>.md` — vault content propagated by Obsidian Sync, not git. After a track save, skip the `/git commit` suggestion. Exceptions: changes that landed inside `.claude/` or `.scripts/` (confirm with `git status`), or the user explicitly asked. A `/git commit` prompt after every track save adds friction the user has to dismiss and risks staging files `.gitignore` would refuse anyway. Mirrors the rule in `home/agents/skills/vault/references/post-edit.md`.

### Importance filter for the Log narrative

Include in the Log entry:

- Outcomes a fresh agent would need to continue the work.
- Decisions made (also written to ## Decisions, but the Log captures _why now_).
- Frictions encountered that aren't yet resolved. Durable open work leaves the Log for a ticket, a ticket's `requires:` edge, or the project scratchpad. `/vault ticket` routes between the three and holds the ticket contract (`home/agents/skills/vault/references/ticket.md`). Mention the friction in the narrative and offer to file it.
- Transient session state: unpushed commits, dirty branches, branch composition, pending pushes. The Log entry is a snapshot the next entry supersedes, so state that expires belongs here and nowhere else.

Exclude:

- Process noise ("we discussed", "we tried X then Y") unless the path itself is the lesson.
- Stylistic exploration that didn't change the outcome.
- Content with a permanent home elsewhere (link to it instead).
