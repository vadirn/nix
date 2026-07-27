# Ticket Creation

Creates a ticket — one unit of decided work, sized to one PR.

A ticket is where friction graduates into work. Open tickets with no `track:` are the project's backlog; setting `track:` assigns one to the effort that owns it. Distinct from a track: a track is one effort's rolling memory across sessions, a ticket is one deliverable inside it.

## Ticket, requires edge, or scratchpad seed

Route the item before creating anything.

- **Ticket** — the work is decided and you can already state the observable condition that closes it. Create `41 projects/<project>/ticket-<slug>.md`.
- **`requires:` edge** — the item blocks work that already has a ticket. Add the blocking ticket's wikilink to the blocked ticket's `requires:`, giving the blocker its own ticket first when it has none. Blocked is derived from a `requires:` entry whose ticket is not yet `done`, which is why `blocked` is absent from `status`. Nothing computes that: `vault-query` prints `requires:` verbatim without opening the named ticket, so check its status yourself.
- **Scratchpad seed** — the item is an idea that may grow into a future effort and has no done-condition yet. Append one line to `41 projects/<project>/scratchpad.md` (`type: scratchpad`, one per project, template `Scratchpad.md`); create that file from the template when the project has none.

## Process

```
config = Bash(vault-query config)   // vault_root, project_path

// Duplicate check — an open ticket may already cover this
open = Bash(vault-query tickets --project <project> --status open --format text)
if a line covers the same work:
  present it, ask: extend that ticket / file a new one?

// Build the ticket
Read(<vault_root>/templates/Ticket.md)
slug = kebab-case, naming the outcome
project_link = the `Project note: [[...]]` line in <project_path>/context.md
write <project_path>/ticket-<slug>.md

// Confirm the body resolves from the repo alone
Bash(vault-query lint --format json | jq '[.[] | select(.rule == "ticket-outward-only")]')
```

## Frontmatter

vault_root = Bash(vault-query config).vault_root Read(<vault_root>/templates/Ticket.md) for structure.

| Field | Value |
| --- | --- |
| `type` | always `ticket` |
| `slug` | the filename's slug, minus the `ticket-` prefix |
| `description` | one sentence. `vault-query tickets` prints it as the ticket's entire summary line, so write it to stand alone. |
| `status` | `open` at creation; `done` once every `## Done when` box is checked; `abandoned` when the work will not happen — keep the file and record why in the body. |
| `project` | wikilink to the project note, copied from `context.md`'s `Project note:` line |
| `created` / `updated` | `YYYY-MM-DD`. `updated` moves on every edit. |
| `track` | wikilink to the track that owns this ticket; empty means no track owns it, which is what puts the ticket in the project backlog. Ownership says where the work belongs, not that it is underway — a track owns its queued tickets alongside the one it is working on. |
| `requires` | list of wikilinks to tickets that must land first; `[]` when none |

Quote frontmatter wikilinks: `project: "[[41 projects/nix/Nix]]"`.

## File naming

`ticket-<slug>.md`, flat in the project folder, parity with `track-<slug>.md` — the folder is already the project, so an Obsidian base reads the project column the way `Tracks.base` does with no new accessor. The slug is kebab-case and names the outcome (`remove-track-backlog`), not the symptom.

## Body

Three sections, in the template's order. Keep the template's leading HTML comment: it carries the self-sufficiency rule to whoever opens the file next.

- **`## What & why`** — numbered list. Each item states a piece of the work together with the reason it matters. Rationale that lives in a planning note gets restated here in full.
- **`## Scope`** — what this ticket covers, which files it touches, and what it deliberately leaves out with a pointer to where that work went instead. One ticket is one PR, so work a single PR cannot hold means the ticket splits.
- **`## Done when`** — checklist. Each box names an observable state a reader can check against the repo (a search returning no hits, a field absent from a file), rather than an activity performed. Tick boxes as the work lands; all boxes ticked is what moves `status` to `done`.

### Repo self-sufficiency

The body resolves for a reader holding only the git repo, because a ticket publishes to that reader. Restate rationale inline and name artifacts the repo resolves — files, symbols, PR numbers. Frontmatter is exempt: `project:`, `track:`, and `requires:` are wikilinks by design.

`vault-query lint`'s `ticket-outward-only` rule flags a body wikilink at warn severity (`vault-query/src/commands/lint/rules/ticket_outward_only.rs`). Run lint after writing.

## Example

File: `41 projects/nix/ticket-remove-track-backlog.md`, abridged.

```markdown
---
type: ticket
slug: remove-track-backlog
description: "Strip the Track skill's Backlog section — template heading and pinned row, save.md handling, read.md phrasing — now that Ticket and Scratchpad exist to hold what it used to carry."
status: done
project: "[[41 projects/nix/Nix]]"
created: 2026-07-24
updated: 2026-07-25
track: "[[41 projects/nix/track-work-tracking-model]]"
requires: []
---

<!-- Body stays repo-self-sufficient: no [[wikilinks]], no vault-entry references. ... -->

## What & why

1. The Track skill's `## Backlog` section holds three different kinds of item under one heading, and the skill's own files disagree on what those are. …
2. Separate work gives each of those three tenants its own home: an action item becomes a ticket file, a blocker becomes a ticket's `requires:` dependency edge, and a deferred seed becomes an entry in a per-project scratchpad file. …

## Scope

One PR, touching three files:

- The Track template …
- `home/agents/skills/track/references/save.md`: remove the `backlog:` field from `proposed_edits` …
- `home/agents/skills/track/references/read.md`: replace "unfold Backlog" …

Out of scope: migrating the Backlog content that already exists in tracks on disk. That is separate work, and it depends on this ticket landing first …

## Done when

- [x] `## Backlog` and its content are gone from the Track template …
- [x] A case-insensitive search for "backlog" across the three touched files returns no hits.
```

## Editing an existing ticket

1. `vault-query read <name>` for the folded shape, then unfold the section the request needs.
2. Tick `## Done when` boxes as the work lands; set `status: done` once they all are.
3. Set `track:` when an effort takes ownership of the ticket; clear it when the effort ends with the ticket still open, returning it to the backlog.
4. Bump `updated:` on every edit.

## Notes

- `vault-query tickets` queries them: `--backlog` (open and unowned — the project backlog), `--track <slug>`, `--status <open|done|abandoned>`, `--project <name>`, `--format <text|markdown|json>`.
- Tickets reach other devices through Obsidian Sync, so apply `references/post-edit.md` and skip the `/git commit` suggestion.
