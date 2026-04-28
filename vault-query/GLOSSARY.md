# Glossary

## Backlink

An incoming link to a file, recorded in a case-insensitive index keyed on `resolve_name(target).to_lowercase()`. A file has backlinks only if its lowercased stem appears as a key in that index.

Example: `vault-query backlinks foo` lists every file containing `[[Foo]]` or `[[foo|alias]]`.

## Backlog completion

The XP event of a completed task (`- [x] (date)`) under the `## Backlog` heading of a WeeklyLog. Subtracts 1 XP from the day on which the task was completed, distinct from Task completion under `## Tasks` which adds 1 XP. The name disambiguates the *event* (XP-bearing) from the `## Backlog` section heading itself, and from the `## Backlog` sections found in Track files (which carry no XP semantics).

Example: marking a `## Backlog` item done in this week's WeeklyLog on Tuesday yields −1 XP for that Tuesday.

## Base file

A YAML file (`.base` extension) that declares top-level filters, property display names, computed formulas, and zero or more named views; the `formulas:` block is stripped before YAML parsing because it contains YAML-hostile characters. By convention base files in use carry one or more views, but a base with no `views:` key parses successfully.

Example: `Checkpoints.base` filters notes with `type == "checkpoint"` and exposes Active and Done views.

## Card

A markdown file with `type: card` in its frontmatter. Conventionally placed under `20 cards/`, but classification is by frontmatter alone — folder placement is not consulted. The `cards` subcommand lists every card with an extra `reference` frontmatter field; files marked `template: true` are excluded.

Example: `vault-query cards` returns every `.md` whose frontmatter has `type: card` and lacks `template: true`.

## Checkpoint

A markdown note with `type: checkpoint` in its frontmatter; tracked with a `done` boolean and optional `decisions` / `frictions` sequence fields. Folder placement is convention only — classification is by `type`. The `vault-query checkpoints` command (separate from the entity itself) is project-scoped: it reads `Checkpoints.base` from the current project, and that base file adds a `file.inFolder("<project>")` clause to the type predicate so the command lists only checkpoints inside the resolved project. Vault-wide listing of all checkpoints by `type` is not exposed by a dedicated subcommand.

Example: a project's `checkpoint-2026-04-28.md` carries `type: checkpoint` and records what was decided that day; `vault-query checkpoints` from inside that project lists it.

## Coverage bonus (XP)

When every project listed in the `## Projects` section of a WeeklyLog has at least one completed task linking to it that week, a bonus equal to `projects.len()` XP is credited to the Monday of the *following* ISO week. Partial coverage yields zero.

Example: a week with three projects, all touched, awards +3 XP on next Monday.

## Filter expression

A single predicate string inside a `FilterSet.and` or `FilterSet.or` list, evaluated against a `VaultFile`. Recognised forms: `field == "str"`, `field == bool`, `file.inFolder("path")`, `!file.inFolder("path")`, `field.containsAny("a","b")`, `field.length > N`. Any other string is unrecognised and silently evaluates to `true` (see Relations & Invariants).

Example: `type == "checkpoint"` and `done == false` together select incomplete checkpoints.

## FilterSet

A pair of expression lists `{and: Vec<String>, or: Vec<String>}` combined as: all `and` clauses must pass AND at least one `or` clause must pass; an empty list for either combinator means "no constraint".

Example: a base with `and: [type == "track"]` and `or: [status == "open", status == "paused"]` selects active tracks.

## Formula

A named expression defined in the `formulas:` block of a `.base` file, evaluated per-file using a mini-language: `if(cond, then, else)`, arithmetic (`+`, `-`, `*`, `/`), `.round(N)`, comparisons, string literals, and bare frontmatter property references. Referenced in views as `formula.<name>`.

Example: `formula.priority = if(urgent, 10, 1)` computes a per-file score.

## Frontmatter

Two senses, distinguished by context. As a *text region*: the YAML block delimited by `---` at the start of a markdown file (BOM-stripped before parsing). As a *parsed result*: the `BTreeMap<String, serde_yaml::Value>` produced from that region — `None` when the opening `---` is absent, an empty map (with a stderr warning) when YAML parsing fails. The parsed-result sense is the one consulted by `type`-based listings, filter expressions, and `frontmatter:` field selection.

Example: `---\ntype: track\nstatus: open\n---` is the text region; it parses to the result `{type: "track", status: "open"}`.

## in_folder match

A file matches `file.inFolder("path")` if and only if its relative path (from vault root) starts with the given string — a bare `starts_with` check with no trailing-slash normalisation.

Example: `file.inFolder("41 projects/nix")` matches files under `41 projects/nix/` *and* `41 projects/nixos/`.

## Level

An integer derived by integer-dividing the total XP for the calendar year being viewed by 50: `level = year_total / 50`. The `year_total` summed by `compute_year` covers only the year passed in (default: current year), not lifetime. Displayed in the XP calendar footer alongside streak and total.

Example: 327 XP accumulated within the year being viewed places the user at level 6 for that year.

## Note

A markdown file with `type: note` in its frontmatter. Conventionally placed under `30 notes/`, but classification is by frontmatter alone. The `notes` subcommand lists every note; files marked `template: true` are excluded.

Example: `vault-query notes` returns every `.md` whose frontmatter has `type: note` and lacks `template: true`.

## Orphan

A vault file whose lowercased filename stem does not appear as a key in the backlink index — i.e. no other `.md` contains a `[[...]]` link whose resolved name matches it.

Example: a freshly created note with no inbound wikilinks shows up in `vault-query orphans`.

## Project

A subdirectory inside `projects_path` (default `41 projects/`). Contains a Project note (`type: project`) and optionally `context.md`, `Checkpoints.base`, `Tracks.base`, plus checkpoint files, tracks, and other project-scoped notes. The `vault-query projects` subcommand lists Project notes via `90 bases/Projects.base` (which filters on `type == "project"`); when that base file is absent it falls back to walking project directories at depth 2 and listing their `.md` files (excluding `checkpoint-*`, `context.md`, `SKILL.md`, `start.md`, `save.md`).

Example: `41 projects/nix/` is the Project directory for the nix repo; the Project note inside it carries `type: project`.

## Project note

A markdown file with `type: project` in its frontmatter, located inside a Project directory. Typically carries `result`, `status`, `deadline`, and `goal` fields per the project template. Selected by `Projects.base` when present.

Example: `41 projects/nix/Nix.md` carries `type: project` and is the Project note for the nix Project.

## Slug

A normalised identifier computed by `slugify(s) = s.to_lowercase().replace(' ', "-")`. The same `slugify()` is applied to both sides of the comparison: the file's relative path (minus `.md`) and the user-supplied query string. A slug matches a file if the two slugified strings are equal, or if the file's slugified path ends with `/<slugified-query>` (folder-aware suffix match).

Example: `41 projects/nix/Nix.md` slugifies to `41-projects/nix/nix`; the query `Nix/Nix` slugifies to `nix/nix` and matches via suffix.

## Sleep date

A calendar date string (YYYY-MM-DD) listed in the `sleep:` YAML sequence in a WeeklyLog's frontmatter; used exclusively to compute the sleep streak — it has no effect on XP task counts.

Example: `sleep: [2026-04-27, 2026-04-28]` records two consecutive logged days.

## Streak

The count of consecutive calendar days ending at today (or the most recent logged day) on which a Sleep date is recorded; computed by walking backwards until a gap is found. Uncapped — a 12-day unbroken streak displays as "12". For the per-day visual intensity used in the calendar render, see Streak day-weight. In code: the `streak: usize` returned from `compute_streak`.

Example: a 12-day unbroken streak shows as "Streak: 12" in the XP footer.

## Streak day-weight

A per-day position value derived from a Streak, used only for visual rendering. For a Streak whose days are sorted oldest-first and 1-indexed, the day at position `n` carries weight `min(n, 7)` — so the first up-to-six days ramp from 1 to 6, and every day from position 7 onward carries weight 7. Independent of the displayed Streak length, which is uncapped. In code: the `day_streak: HashMap<String, usize>` map keyed by date.

Example: in a 12-day streak the six most recent days each carry day-weight 7 (full intensity); the six earliest days carry weights 1 through 6.

## Task

A markdown list item under `## Tasks` or `## Backlog` of a WeeklyLog. Two states: open (`- [ ] ...`) and completed (`- [x] (YYYY-MM-DD) ...`). Only completed tasks contribute to XP, and only when the completion date is present in the leading `(YYYY-MM-DD)` form — the regex `^\s*- \[x\] \((\d{4}-\d{2}-\d{2})\)` is the gate. A completed Task in `## Tasks` adds +1 XP to the date in its prefix; a completed Task in `## Backlog` subtracts 1 XP from that date. Open tasks and completed tasks lacking the date prefix are ignored by XP. Wikilinks `[[Project]]` inside a `## Tasks` line additionally feed the Coverage bonus check.

Example: `- [x] (2026-04-28) ship glossary [[Nix]]` under `## Tasks` adds +1 XP to 2026-04-28 and counts `Nix` as a touched project for that week's coverage check.

## Template

A VaultFile marked `template: true` in its frontmatter. Carries the same `type:` value as its target instance (e.g., a card template has `type: card`) so that instantiation copies the frontmatter into a properly-classified new file. Excluded from type-based listings (`cards`, `notes`) so the template is not itself reported as an instance.

Example: `templates/Card.md` has `template: true` and `type: card` — when used as a template, the new file inherits `type: card`; the template itself is omitted from `vault-query cards` output.

## Track

A markdown note with `type: track` in its frontmatter. Valid statuses: `open`, `paused`, `done`, `abandoned`, `superseded`. Folder placement is convention only — classification is by `type`. The `vault-query tracks` command (separate from the entity itself) is project-scoped: it reads `Tracks.base` from the current project, and that base file adds a `file.inFolder("<project>")` clause to the type predicate, exposing status-keyed views including Active (`status.containsAny("open", "paused")`). Vault-wide listing of all tracks by `type` is not exposed by a dedicated subcommand.

Example: `track-vault-query-logic-check.md` carries `type: track` and is listed by `vault-query tracks` from inside the nix project.

## Unresolved link

A `[[wikilink]]` whose resolved name (lowercased file stem) does not match any existing vault file's lowercased stem. Collected across all files and reported as distinct target strings.

Example: `[[NotARealNote]]` in any file shows up in `vault-query unresolved`.

## VaultFile

The in-memory representation of a parsed `.md` file, holding absolute path, filename stem (`name`), parsed frontmatter (`BTreeMap<String, serde_yaml::Value>`), raw content string, and optional creation time. Bad-frontmatter files are included with an empty map and a warning, not excluded.

Example: every entry in the result of `Vault::scan` is a `VaultFile`.

## View

A named projection within a `.base` file that applies its own `FilterSet` on top of the base-level filter, then selects, orders, sorts, optionally groups by a property or formula, and optionally computes column summaries (Sum or Average). Sorting is lexicographic string comparison; default direction is DESC when `direction` is absent or not `"ASC"`.

Example: the Active view in `Tracks.base` lists open and paused tracks sorted by `updated` DESC.

## WeeklyLog

A markdown file with `type: weekly-log` in its frontmatter; carries `week` (ISO week string, e.g. `2026-W12`), `sleep` (date sequence), and `start` / `end` date strings. Folder placement (`41 projects/block-buster/`) and filename shape (`YYYY-wNN.md`) are convention only — classification is by `type`. Contains `## Projects`, `## Tasks`, and `## Backlog` sections used by XP computation. The `vault-query xp` command is the sole consumer; no dedicated listing subcommand is exposed.

Example: `2026-W17.md` carries `type: weekly-log` and covers 2026-04-27 through 2026-05-03.

## Relations & Invariants

A WeeklyLog contains zero-or-one `## Tasks`, `## Backlog`, and `## Projects` sections.

A Task in `## Tasks` adds +1 XP to the day it was completed; a Task in `## Backlog` subtracts 1 XP from the day it was completed. The same line cannot appear in both sections.

The Coverage bonus is all-or-nothing: it is awarded only when every Project listed in `## Projects` is referenced by at least one completed Task that week.

The Coverage bonus credits the Monday of the ISO week *following* the week being scored, not the week itself.

Streak counts consecutive calendar days with a Sleep date ending at today; a single missing day resets the streak.

The Streak value displayed to the user is uncapped; the per-day position weight used for visual rendering is capped at 7. Streak length and per-day weight are different quantities.

Level equals integer-divided total XP for the calendar year being viewed by 50; it is computed per year, not lifetime.

Card, Note, Checkpoint, Track, WeeklyLog, and the project note are disjoint subtypes of VaultFile, partitioned on a single basis: the frontmatter `type` value (`card`, `note`, `checkpoint`, `track`, `weekly-log`, `project`). Folder placement (`20 cards/`, `30 notes/`, `41 projects/block-buster/`, project folders) is convention only at the entity level — the type axis alone determines membership. The `vault-query cards` and `vault-query notes` subcommands list by `type` vault-wide; the `vault-query checkpoints` and `vault-query tracks` subcommands list by `type` AND `file.inFolder(<current project>)` because their per-project base files embed the folder clause. The folder restriction is a property of those two commands, not of the entity definitions. WeeklyLog has no dedicated listing subcommand: `vault-query xp` is its sole consumer and selects files by `type == "weekly-log"` AND `template != true` (`commands/xp.rs::parse_weekly_logs`).

A VaultFile marked `template: true` is a template, not an instance: it carries the `type:` of its target so instantiation produces a properly-typed file, and is excluded from type-based listings.

A Track has exactly one `status` value drawn from `{open, paused, done, abandoned, superseded}`; the Active view selects exactly `{open, paused}`.

A FilterSet evaluates to true only if all `and` clauses pass *and*, when `or` is non-empty, at least one `or` clause passes; an empty `and` or `or` list is treated as "no constraint".

An unrecognised Filter expression evaluates to `true` (silent pass-through), not an error.

A `file.inFolder("X")` predicate is satisfied by any file whose relative path starts with the literal string `X`; folder boundaries are not enforced, so `"41 projects/nix"` matches files under `"41 projects/nixos/"`.

A Slug match applies the same `slugify()` to both the file's relative path (minus `.md`) and the user-supplied query before comparison; a match holds iff the slugified strings are equal, or the file's slugified path ends with `/<slugified-query>`.

An Orphan is a VaultFile whose lowercased filename stem appears in no Backlink index entry; resolution is name-only, so two files sharing a stem cannot be told apart.

An Unresolved link is a `[[target]]` whose lowercased resolved name does not match any VaultFile's lowercased stem; aliases (`[[target|alias]]`) do not affect resolution.
