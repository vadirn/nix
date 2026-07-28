//! `tickets` — a view into the project's `Tickets.base`.
//!
//! Structurally the twin of [`super::tracks`], and shares its plumbing through
//! [`super::project_base`]. The one thing tickets need that tracks do not is
//! `--track <slug>`, whose argument is known only at call time and so cannot be
//! a declared view; it arrives through [`super::query::Narrowing`], which both
//! validates the slug against the project's tracks and selects the tickets they
//! own.

use anyhow::{Result, bail};
use serde_yaml::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use crate::base;
use crate::commands::project_base::ProjectBase;
use crate::commands::query::Narrowing;
use crate::config::ResolvedConfig;
use crate::frontmatter;
use crate::output::Format;
use crate::vault::VaultFile;
use crate::wikilink;

const BASE: ProjectBase = ProjectBase {
    file_name: "Tickets.base",
    init_command: "tickets-init",
    template: render_template,
};

/// Resolve the track that owns a ticket to a bare slug.
///
/// The ticket's `track:` frontmatter is a backref wikilink whose target stem is
/// `track-<slug>` (e.g. `[[41 projects/nix/track-work-tracking-model]]`). We
/// resolve query-side from the wikilink's **target**, stripping the folder
/// prefix ([`wikilink::resolve_name`]) and then the `track-` prefix, rather than
/// opening the linked track file to read its `slug:`. The stem is
/// self-contained, so resolution never depends on the target track file being
/// present or scannable — the robust choice for a filter.
///
/// The target, never the alias: `[[…/track-foo|Work tracking model]]` owns
/// `foo`, and reading the alias instead would name a slug no user can type. A
/// bare (non-wikilink) value passes through trimmed, since
/// [`wikilink::extract`] yields nothing for it. When the field holds a sequence,
/// the first wikilink wins — [`frontmatter::get_display`] would otherwise join
/// the members with `, ` into a stem matching nothing.
///
/// Returns `None` for every value the shared [`crate::base::is_truthy`] calls
/// falsy — absent, `null`, empty, `false`, `0` — so an unowned ticket reads the
/// same way here as under the Backlog view's `!track.isTruthy()`. That gate runs
/// *before* the parse deliberately: [`crate::base::filter::apply`] evaluates
/// this predicate ahead of the declared filters, over every file in the vault,
/// so parsing first would put a full Markdown parse on all of them, mostly on
/// the empty string.
fn ticket_track_slug(fm: &BTreeMap<String, Value>) -> Option<String> {
    let raw = frontmatter::get_display(fm, "track");
    if !base::is_truthy(&raw) {
        return None;
    }
    let links = wikilink::extract(&raw);
    let stem = links
        .first()
        .map(|w| wikilink::resolve_name(&w.target))
        .unwrap_or_else(|| raw.trim())
        .trim();
    if stem.is_empty() {
        return None;
    }
    Some(slug_from_stem(stem).to_string())
}

/// The slug a track file's stem names: `track-foo` is the file, `foo` is the slug.
///
/// Called from both sides of the `--track` match — from [`ticket_track_slug`]
/// for the stem a ticket backrefs, and from [`project_track_slugs`] for the
/// stem a track file has — so the roster the CLI validates against and the
/// values it compares can only be derived one way.
fn slug_from_stem(stem: &str) -> &str {
    stem.strip_prefix("track-").unwrap_or(stem)
}

/// Every track slug the resolved project declares, as `--track` names them.
///
/// The roster is the project's own track *files*, not the tracks its tickets
/// happen to backref: a track that exists but owns nothing yet is a legitimate
/// `--track` argument whose answer is an empty table, and deriving the roster
/// from backrefs would report it as a typo.
///
/// Scoped by [`Path::starts_with`], which compares whole components — the base
/// itself is scoped by `file.inFolder(…)`, so a roster gathered vault-wide
/// would accept a slug from a project whose tickets this command cannot see.
fn project_track_slugs(files: &[VaultFile], project_path: &Path) -> BTreeSet<String> {
    files
        .iter()
        .filter(|f| f.path.starts_with(project_path))
        .filter(|f| frontmatter::get_display(&f.frontmatter, "type") == "track")
        .filter_map(|f| f.path.file_stem())
        .map(|stem| slug_from_stem(&stem.to_string_lossy()).to_string())
        .collect()
}

/// Accept `slug` only if the project declares a track by that name.
///
/// Without this, `--track` answers an unresolvable name with an empty table and
/// exit 0 — the reader cannot tell a typo from a track whose tickets are all
/// closed, which is the failure the `precheck` slot exists to separate.
///
/// The `track-` branch is the copy-paste path, and it rejects rather than
/// accepts: the Track column renders the wikilink's file stem (as Obsidian does
/// for the same base), so `track-foo` is what a user sees and `foo` is what the
/// track's own `slug:` says it is called. Accepting both would give one track
/// two names; naming the right one costs a single correction.
fn check_track_declared(files: &[VaultFile], project_path: &Path, slug: &str) -> Result<()> {
    let known = project_track_slugs(files, project_path);
    if known.contains(slug) {
        return Ok(());
    }
    if let Some(bare) = slug.strip_prefix("track-")
        && known.contains(bare)
    {
        bail!(
            "no track \"{slug}\" — that is the file stem the Track column renders; \
             the slug is \"{bare}\""
        );
    }
    if known.is_empty() {
        bail!(
            "no track \"{slug}\": {} declares no tracks",
            project_path.display()
        );
    }
    // A project can carry dozens of tracks, so the whole roster is a wall of
    // text, not a hint. Offer the ones sharing a first segment — a typo usually
    // keeps it — and leave the full list to the command that renders it.
    let head = slug.split('-').next().unwrap_or(slug);
    let near: Vec<&str> = known
        .iter()
        .filter(|k| k.split('-').next() == Some(head))
        .map(String::as_str)
        .collect();
    if near.is_empty() {
        bail!(
            "no track \"{slug}\"; this project declares {} — `vault-query tracks --view All` lists them",
            known.len()
        );
    }
    bail!(
        "no track \"{slug}\"; close matches: {} (of {} — `vault-query tracks --view All` lists them)",
        near.join(", "),
        known.len()
    );
}

/// Whether the track named `slug` owns `file`.
///
/// This is the predicate `--track` narrows a view by, named so that the tests
/// exercise the shipped one instead of a second copy that could drift from it.
/// The match is on the whole stem, not a substring: slug `foo` must not select a
/// ticket owned by `track-foo-bar`.
fn owned_by_track(file: &VaultFile, slug: &str) -> bool {
    ticket_track_slug(&file.frontmatter).as_deref() == Some(slug)
}

/// Render one view of the project's `Tickets.base`, optionally narrowed to the
/// tickets one track owns.
///
/// `--track <slug>` and `--view Backlog` are rejected together: Backlog
/// selects tickets with no owning track (`!track.isTruthy()`), `--track`
/// selects tickets a track owns, so their intersection is empty by
/// construction. This crate treats other impossible-by-construction inputs
/// (an unresolved `--project`, a missing `Tickets.base`) as hard errors rather
/// than a silent empty result, so this combination follows the same shape — as
/// does a `--track` naming no track the project declares, via
/// [`check_track_declared`].
pub fn run(cfg: &ResolvedConfig, view: &str, track: Option<&str>, format: Format) -> Result<()> {
    let Some(slug) = track else {
        return BASE.run(cfg, view, format, Narrowing::default());
    };
    if view == "Backlog" {
        bail!(
            "--track {slug} and --view Backlog can never match anything together: \
             Backlog selects only tickets with no owning track, --track narrows to \
             tickets owned by \"{slug}\""
        );
    }
    // `project_path` is `Some` by the time a precheck runs: `ProjectBase::run`
    // resolves it before opening the base, and errors when it cannot.
    let declared = |files: &[VaultFile]| match cfg.project_path.as_deref() {
        Some(project_path) => check_track_declared(files, project_path, slug),
        None => Ok(()),
    };
    let owned = |f: &VaultFile| owned_by_track(f, slug);
    BASE.run(
        cfg,
        view,
        format,
        Narrowing {
            precheck: Some(&declared),
            select: Some(&owned),
        },
    )
}

/// Write the starter `Tickets.base` into the resolved project.
pub fn init(cfg: &ResolvedConfig) -> Result<()> {
    BASE.init(cfg)
}

fn render_template(folder: &str) -> String {
    format!(
        r#"filters:
  and:
    - type == "ticket"
    - file.inFolder("{folder}")
properties:
  file.name:
    displayName: Ticket
  note.slug:
    displayName: Slug
  note.status:
    displayName: Status
  note.track:
    displayName: Track
  note.requires:
    displayName: Requires
  note.description:
    displayName: Description
  note.created:
    displayName: Created
  note.updated:
    displayName: Updated
views:
  - type: table
    name: Backlog
    filters:
      and:
        - status == "open"
        - "!track.isTruthy()"
    order:
      - file.name
      - requires
      - description
      - updated
    sort:
      - property: updated
        direction: DESC
  - type: table
    name: Open
    filters:
      and:
        - status == "open"
    order:
      - file.name
      - track
      - requires
      - description
      - updated
    sort:
      - property: updated
        direction: DESC
  - type: table
    name: Done
    filters:
      and:
        - status == "done"
    order:
      - file.name
      - track
      - description
      - updated
    sort:
      - property: updated
        direction: DESC
  - type: table
    name: Abandoned
    filters:
      and:
        - status == "abandoned"
    order:
      - file.name
      - track
      - description
      - updated
    sort:
      - property: updated
        direction: DESC
  - type: table
    name: By Track
    groupBy:
      property: track
      direction: ASC
    order:
      - file.name
      - status
      - description
      - updated
    sort:
      - property: updated
        direction: DESC
  - type: table
    name: By Status
    groupBy:
      property: status
      direction: ASC
    order:
      - file.name
      - track
      - description
      - updated
    sort:
      - property: updated
        direction: DESC
  - type: table
    name: All
    order:
      - file.name
      - status
      - track
      - requires
      - description
      - created
      - updated
    sort:
      - property: updated
        direction: DESC
"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::base;
    use crate::base::filter;
    use crate::commands::project_base::assert_template_views;
    use crate::vault;
    use crate::vault_ignore::VaultIgnore;
    use std::path::Path;
    use tempfile::TempDir;

    /// A temp vault under `41 projects/nix/` with an owned ticket, an unowned
    /// open ticket (the backlog case), a done ticket, and a plain note.
    fn build_ticket_vault() -> TempDir {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("41 projects/nix");
        std::fs::create_dir_all(&dir).unwrap();

        std::fs::write(
            dir.join("ticket-owned.md"),
            "---\ntype: ticket\nslug: owned\ndescription: An owned ticket\nstatus: open\n\
             track: \"[[41 projects/nix/track-work-tracking-model]]\"\nrequires: []\n---\nbody\n",
        )
        .unwrap();

        std::fs::write(
            dir.join("ticket-backlog.md"),
            "---\ntype: ticket\nslug: backlog\ndescription: An unowned open ticket\nstatus: open\n\
             track:\nrequires:\n  - \"[[41 projects/nix/ticket-owned]]\"\n---\nbody\n",
        )
        .unwrap();

        std::fs::write(
            dir.join("ticket-done.md"),
            "---\ntype: ticket\nslug: done\ndescription: A finished ticket\nstatus: done\n\
             track:\nrequires: []\n---\nbody\n",
        )
        .unwrap();

        std::fs::write(
            dir.join("just-a-note.md"),
            "---\ntype: note\nslug: note\n---\nbody\n",
        )
        .unwrap();

        // The track `ticket-owned` backrefs, plus one that owns nothing: a real
        // project's roster is its track files, not the tracks its tickets name.
        std::fs::write(
            dir.join("track-work-tracking-model.md"),
            "---\ntype: track\nslug: work-tracking-model\nstatus: open\n---\nbody\n",
        )
        .unwrap();

        std::fs::write(
            dir.join("track-lonely.md"),
            "---\ntype: track\nslug: lonely\nstatus: open\n---\nbody\n",
        )
        .unwrap();

        tmp
    }

    /// Scan the fixture and resolve `slug` against it, as the `precheck` slot does.
    fn declared(root: &Path, slug: &str) -> Result<()> {
        let files = vault::scan(root, root, Some(&VaultIgnore::from_patterns(vec![]))).unwrap();
        check_track_declared(&files, &root.join("41 projects/nix"), slug)
    }

    /// Run one view of the rendered template against a scanned temp vault,
    /// returning the selected slugs. This is the pipeline `run` delegates to,
    /// minus rendering.
    fn select(root: &Path, view_name: &str, track: Option<&str>) -> Vec<String> {
        let base_path = root.join("41 projects/nix/Tickets.base");
        std::fs::write(&base_path, render_template("41 projects/nix")).unwrap();
        let base_file = base::parse(&base_path).unwrap();
        let view = base_file
            .views
            .iter()
            .find(|v| v.name == view_name)
            .unwrap_or_else(|| panic!("view {view_name} missing from the template"));

        let files = vault::scan(root, root, Some(&VaultIgnore::from_patterns(vec![]))).unwrap();
        // The shipped predicate, not a second copy of it.
        let owned = track.map(|slug| move |f: &VaultFile| owned_by_track(f, slug));
        let extra: Option<&dyn Fn(&VaultFile) -> bool> = match owned {
            Some(ref p) => Some(p),
            None => None,
        };

        let mut selected =
            filter::apply(&files, &base_file.filters, &view.filters, root, extra).unwrap();
        selected.sort_by(|a, b| a.path.cmp(&b.path));
        selected
            .iter()
            .map(|f| f.get_property("slug"))
            .collect::<Vec<_>>()
    }

    #[test]
    fn all_view_excludes_non_tickets() {
        let tmp = build_ticket_vault();
        assert_eq!(
            select(tmp.path(), "All", None),
            ["backlog", "done", "owned"]
        );
    }

    #[test]
    fn backlog_view_is_open_and_unowned() {
        // The `!track.isTruthy()` predicate: `owned` has a track, `done` is closed.
        let tmp = build_ticket_vault();
        assert_eq!(select(tmp.path(), "Backlog", None), ["backlog"]);
    }

    #[test]
    fn open_view_keeps_both_owned_and_unowned() {
        let tmp = build_ticket_vault();
        assert_eq!(select(tmp.path(), "Open", None), ["backlog", "owned"]);
    }

    #[test]
    fn track_predicate_narrows_a_view_by_backref_stem() {
        let tmp = build_ticket_vault();
        assert_eq!(
            select(tmp.path(), "Open", Some("work-tracking-model")),
            ["owned"]
        );
        assert!(select(tmp.path(), "Open", Some("nonexistent-track")).is_empty());
    }

    #[test]
    fn run_rejects_track_combined_with_the_backlog_view() {
        // Backlog is `!track.isTruthy()`; `--track` selects the opposite. The
        // combination is empty by construction, so `run` must error rather
        // than silently print nothing, naming both flags in the message.
        let tmp = build_ticket_vault();
        let cfg = ResolvedConfig {
            vault_root: tmp.path().to_path_buf(),
            projects_path: None,
            project_path: Some(tmp.path().join("41 projects/nix")),
            log_project_path: String::new(),
            lint: None,
            consult: None,
            ignore: VaultIgnore::from_patterns(vec![]),
        };
        let err = run(&cfg, "Backlog", Some("work-tracking-model"), Format::Table)
            .unwrap_err()
            .to_string();
        assert!(err.contains("--track"), "{err}");
        assert!(err.contains("--view Backlog"), "{err}");
    }

    #[test]
    fn cli_backlog_and_base_backlog_view_select_the_same_set() {
        // The duplication this command was collapsed to remove: the CLI's notion
        // of "backlog" and the Backlog view of the vault-wide 41 projects/Tickets.base
        // must be one predicate, not two hand-synchronized ones.
        let tmp = build_ticket_vault();
        let vault_wide = tmp.path().join("41 projects/Tickets.base");
        std::fs::write(&vault_wide, render_template("41 projects")).unwrap();
        let base_file = base::parse(&vault_wide).unwrap();
        let view = base_file
            .views
            .iter()
            .find(|v| v.name == "Backlog")
            .unwrap();

        let files = vault::scan(
            tmp.path(),
            tmp.path(),
            Some(&VaultIgnore::from_patterns(vec![])),
        )
        .unwrap();
        let wide =
            filter::apply(&files, &base_file.filters, &view.filters, tmp.path(), None).unwrap();
        let wide_slugs: Vec<String> = wide.iter().map(|f| f.get_property("slug")).collect();

        assert_eq!(wide_slugs, select(tmp.path(), "Backlog", None));
    }

    #[test]
    fn track_slug_helper_strips_prefix_and_handles_empty() {
        let mut fm = BTreeMap::new();
        assert_eq!(ticket_track_slug(&fm), None);
        fm.insert("track".to_string(), Value::Null);
        assert_eq!(ticket_track_slug(&fm), None);
        fm.insert(
            "track".to_string(),
            Value::String("[[41 projects/nix/track-foo-bar]]".to_string()),
        );
        assert_eq!(ticket_track_slug(&fm), Some("foo-bar".to_string()));
    }

    /// One `track` value, resolved.
    fn slug_of(track: Value) -> Option<String> {
        let mut fm = BTreeMap::new();
        fm.insert("track".to_string(), track);
        ticket_track_slug(&fm)
    }

    #[test]
    fn track_slug_resolves_the_wikilink_target_not_its_alias() {
        // Aliasing the backref for a readable Track column is the natural thing
        // to do in Obsidian, and `wikilink::strip` would answer with the alias
        // ("Work tracking model") — a slug no user can type, so the ticket would
        // drop out of `--track work-tracking-model` with exit 0 and no
        // diagnostic while the Backlog view still counted it owned.
        assert_eq!(
            slug_of(Value::String(
                "[[41 projects/nix/track-work-tracking-model|Work tracking model]]".to_string()
            )),
            Some("work-tracking-model".to_string())
        );
    }

    #[test]
    fn track_slug_takes_the_first_wikilink_of_a_sequence() {
        // `get_display` joins a sequence with ", ", so resolving the flattened
        // string would yield the stem "track-a, track-b", matching nothing.
        assert_eq!(
            slug_of(Value::Sequence(vec![
                Value::String("[[41 projects/nix/track-a]]".to_string()),
                Value::String("[[41 projects/nix/track-b]]".to_string()),
            ])),
            Some("a".to_string())
        );
    }

    #[test]
    fn track_slug_passes_a_bare_value_through() {
        assert_eq!(
            slug_of(Value::String("track-foo-bar".to_string())),
            Some("foo-bar".to_string())
        );
        assert_eq!(
            slug_of(Value::String("  foo-bar  ".to_string())),
            Some("foo-bar".to_string())
        );
    }

    #[test]
    fn track_slug_is_none_for_every_value_the_backlog_view_calls_unowned() {
        // The shared `base::is_truthy` gate: these are exactly the values
        // `!track.isTruthy()` puts in the Backlog view, so `--track` must agree
        // that none of them owns the ticket.
        assert_eq!(slug_of(Value::String(String::new())), None);
        assert_eq!(slug_of(Value::String("   ".to_string())), None);
        assert_eq!(slug_of(Value::Bool(false)), None);
        assert_eq!(slug_of(Value::Number(0.into())), None);
        assert_eq!(slug_of(Value::Sequence(vec![])), None);
    }

    #[test]
    fn template_parses_and_declares_every_documented_view() {
        assert_template_views(
            render_template,
            &[
                "Backlog",
                "Open",
                "Done",
                "Abandoned",
                "By Track",
                "By Status",
                "All",
            ],
        );
    }

    #[test]
    fn a_track_the_project_declares_resolves() {
        let tmp = build_ticket_vault();
        declared(tmp.path(), "work-tracking-model").unwrap();
    }

    /// The discriminator the `precheck` slot exists for: a track that owns
    /// nothing is a valid argument whose truthful answer is an empty table, and
    /// must not be reported as a typo.
    #[test]
    fn a_track_owning_no_tickets_resolves_and_selects_nothing() {
        let tmp = build_ticket_vault();
        declared(tmp.path(), "lonely").unwrap();
        assert!(select(tmp.path(), "All", Some("lonely")).is_empty());
    }

    #[test]
    fn the_rendered_file_stem_is_rejected_and_names_the_slug() {
        let tmp = build_ticket_vault();
        let err = declared(tmp.path(), "track-work-tracking-model")
            .unwrap_err()
            .to_string();
        assert!(err.contains("the slug is \"work-tracking-model\""), "{err}");
    }

    #[test]
    fn a_typo_keeping_its_first_segment_gets_the_close_match() {
        let tmp = build_ticket_vault();
        let err = declared(tmp.path(), "work-trackign-model")
            .unwrap_err()
            .to_string();
        assert!(err.contains("close matches: work-tracking-model"), "{err}");
        // The roster is the hint's ceiling, not its body — a real project has
        // dozens of tracks and the unrelated ones are noise.
        assert!(!err.contains("lonely"), "{err}");
    }

    #[test]
    fn an_unrecognisable_track_names_the_command_that_lists_them() {
        let tmp = build_ticket_vault();
        let err = declared(tmp.path(), "zzz").unwrap_err().to_string();
        assert!(err.contains("vault-query tracks --view All"), "{err}");
    }

    /// The roster is scoped by whole path components, so a sibling project whose
    /// folder name this one prefixes cannot lend it a slug.
    #[test]
    fn a_track_in_another_project_is_not_in_the_roster() {
        let tmp = build_ticket_vault();
        let sibling = tmp.path().join("41 projects/nixos");
        std::fs::create_dir_all(&sibling).unwrap();
        std::fs::write(
            sibling.join("track-elsewhere.md"),
            "---\ntype: track\nslug: elsewhere\nstatus: open\n---\nbody\n",
        )
        .unwrap();

        let err = declared(tmp.path(), "elsewhere").unwrap_err().to_string();
        assert!(err.contains("no track \"elsewhere\""), "{err}");
        // Counted against this project's two, not the sibling's three.
        assert!(err.contains("declares 2"), "{err}");
    }

    /// Both sides of the match go through [`slug_from_stem`], so the roster
    /// cannot name a track by one spelling while a backref resolves to another.
    #[test]
    fn the_roster_and_a_backref_agree_on_one_slug() {
        let tmp = build_ticket_vault();
        let root = tmp.path();
        let files = vault::scan(root, root, Some(&VaultIgnore::from_patterns(vec![]))).unwrap();
        let roster = project_track_slugs(&files, &root.join("41 projects/nix"));

        let owner = files
            .iter()
            .find(|f| f.get_property("slug") == "owned")
            .unwrap();
        let backref = ticket_track_slug(&owner.frontmatter).unwrap();
        assert!(roster.contains(&backref), "{roster:?} lacks {backref}");
    }
}
