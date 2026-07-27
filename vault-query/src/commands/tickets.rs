use anyhow::Result;
use serde::Serialize;
use serde_yaml::Value;
use std::collections::BTreeMap;
use std::path::Path;
use std::str::FromStr;

use crate::config::ResolvedConfig;
use crate::frontmatter;
use crate::vault::{self, VaultFile};
use crate::wikilink;

/// Fallback projects folder when the config omits `projects_path`.
const DEFAULT_PROJECTS_PATH: &str = "41 projects";

/// Output format for the `tickets` listing. Three variants so the same command
/// serves a human (`text`), a resuming skill (`markdown`), and a machine
/// (`json`); mirrors the `--format` conventions of the `search` (text/json) and
/// `consult` (markdown/json) commands.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TicketFormat {
    Text,
    Markdown,
    Json,
}

impl FromStr for TicketFormat {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "text" => Ok(TicketFormat::Text),
            "markdown" | "md" => Ok(TicketFormat::Markdown),
            "json" => Ok(TicketFormat::Json),
            _ => Err(format!(
                "unknown format: {} (expected text, markdown, or json)",
                s
            )),
        }
    }
}

impl std::fmt::Display for TicketFormat {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TicketFormat::Text => write!(f, "text"),
            TicketFormat::Markdown => write!(f, "markdown"),
            TicketFormat::Json => write!(f, "json"),
        }
    }
}

/// One ticket projected into its key fields. The `track` and `requires`
/// wikilinks are resolved to bare slugs/names here so every output format shares
/// one resolved shape.
#[derive(Debug, Serialize)]
pub struct Ticket {
    /// Vault-relative path (`41 projects/nix/ticket-remove-track-backlog.md`).
    pub path: String,
    /// The `slug:` frontmatter value.
    pub slug: String,
    /// The `status:` frontmatter value (`open`, `done`, `abandoned`).
    pub status: String,
    pub description: String,
    /// Resolved track slug (the `track-` prefix stripped from the backref
    /// wikilink target stem), empty when no track owns the ticket.
    pub track: String,
    /// Resolved blocking-ticket names from the `requires:` sequence.
    pub requires: Vec<String>,
    /// Project name derived from the folder under `projects_path`, empty when the
    /// ticket lives outside a project directory.
    pub project: String,
}

/// JSON envelope for `--format json`, borrowing the selected tickets.
#[derive(Serialize)]
struct TicketsOutput<'a> {
    count: usize,
    tickets: &'a [Ticket],
}

/// Resolve the track that owns a ticket to a bare slug.
///
/// The ticket's `track:` frontmatter is a backref wikilink whose target stem is
/// `track-<slug>` (e.g. `[[41 projects/nix/track-work-tracking-model]]`). We
/// resolve query-side by taking the wikilink target's basename
/// ([`wikilink::strip`] → [`wikilink::resolve_name`]) and stripping the `track-`
/// prefix, rather than opening the linked track file to read its `slug:`. The
/// stem is self-contained, so resolution never depends on the target track file
/// being present or scannable — the robust choice for a filter. A bare
/// (non-wikilink) value is accepted too, since `strip` passes it through
/// unchanged. Returns `None` when the field is empty or missing.
fn ticket_track_slug(fm: &BTreeMap<String, Value>) -> Option<String> {
    let raw = frontmatter::get_display(fm, "track");
    let stem = wikilink::strip(&raw);
    let stem = stem.trim();
    if stem.is_empty() {
        return None;
    }
    Some(stem.strip_prefix("track-").unwrap_or(stem).to_string())
}

/// Resolve the `requires:` sequence to bare ticket names (wikilink syntax and
/// folder prefixes stripped). Empty items are dropped.
fn ticket_requires(fm: &BTreeMap<String, Value>) -> Vec<String> {
    frontmatter::get_string_seq(fm, "requires")
        .iter()
        .map(|r| wikilink::strip(r).trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Derive a project name from a vault-relative path: the folder segment directly
/// under `projects_path`. Returns an empty string for tickets outside a project,
/// or sitting directly in `projects_path` with no project folder.
fn ticket_project(rel_path: &str, projects_path: &str) -> String {
    let prefix = format!("{projects_path}/");
    let Some(rest) = rel_path.strip_prefix(&prefix) else {
        return String::new();
    };
    match rest.split_once('/') {
        Some((folder, _file)) => folder.to_string(),
        None => String::new(),
    }
}

/// Filter scanned vault files down to the tickets matching the given criteria,
/// projecting each into a [`Ticket`]. Pure over its inputs so tests can drive it
/// with a scanned temp vault and assert on the returned set.
///
/// - `project_scope`: when `Some`, keep only tickets whose absolute path is under
///   this directory (the resolved `--project` folder).
/// - `track`: keep only tickets whose resolved track slug equals this.
/// - `backlog`: keep only tickets no track owns (`track` empty) with `status == open`.
/// - `status`: keep only tickets whose `status` equals this.
fn select(
    files: &[VaultFile],
    vault_root: &Path,
    projects_path: &str,
    project_scope: Option<&Path>,
    track: Option<&str>,
    backlog: bool,
    status: Option<&str>,
) -> Vec<Ticket> {
    let mut tickets: Vec<Ticket> = files
        .iter()
        .filter(|f| frontmatter::get_display(&f.frontmatter, "type") == "ticket")
        .filter(|f| !frontmatter::is_template(&f.frontmatter))
        .filter(|f| project_scope.is_none_or(|dir| f.path.starts_with(dir)))
        .filter_map(|f| {
            let ticket_status = frontmatter::get_display(&f.frontmatter, "status");
            let track_slug = ticket_track_slug(&f.frontmatter);

            if let Some(want) = status {
                if ticket_status != want {
                    return None;
                }
            }
            if let Some(want) = track {
                if track_slug.as_deref() != Some(want) {
                    return None;
                }
            }
            if backlog && (track_slug.is_some() || ticket_status != "open") {
                return None;
            }

            let rel = f.relative_path(vault_root);
            Some(Ticket {
                slug: frontmatter::get_display(&f.frontmatter, "slug"),
                status: ticket_status,
                description: frontmatter::get_display(&f.frontmatter, "description"),
                track: track_slug.unwrap_or_default(),
                requires: ticket_requires(&f.frontmatter),
                project: ticket_project(&rel, projects_path),
                path: rel,
            })
        })
        .collect();

    tickets.sort_by(|a, b| a.path.cmp(&b.path));
    tickets
}

/// List `type: ticket` notes, optionally scoped by `--project` (the global
/// project flag), `--track`, `--backlog`, and `--status`.
pub fn run(
    cfg: &ResolvedConfig,
    track: Option<&str>,
    backlog: bool,
    status: Option<&str>,
    format: TicketFormat,
) -> Result<()> {
    let vault_root = &cfg.vault_root;
    let files = vault::scan(vault_root, vault_root, Some(&cfg.ignore))?;
    let projects_path = cfg
        .projects_path
        .as_deref()
        .unwrap_or(DEFAULT_PROJECTS_PATH);

    let tickets = select(
        &files,
        vault_root,
        projects_path,
        cfg.project_path.as_deref(),
        track,
        backlog,
        status,
    );

    match format {
        TicketFormat::Text => print_text(&tickets),
        TicketFormat::Markdown => print_markdown(&tickets),
        TicketFormat::Json => print_json(&tickets)?,
    }
    Ok(())
}

/// One line per ticket, following the `(field: value)` shape of the `list`
/// command: `slug — description (status: …) (track: …) (requires: …) (path)`.
fn print_text(tickets: &[Ticket]) {
    for t in tickets {
        let ident = if t.slug.is_empty() { &t.path } else { &t.slug };
        let mut line = ident.clone();
        if !t.description.is_empty() {
            line.push_str(" — ");
            line.push_str(&t.description);
        }
        line.push_str(&format!(" (status: {})", t.status));
        if !t.track.is_empty() {
            line.push_str(&format!(" (track: {})", t.track));
        }
        if !t.requires.is_empty() {
            line.push_str(&format!(" (requires: {})", t.requires.join(", ")));
        }
        line.push_str(&format!(" ({})", t.path));
        println!("{line}");
    }
}

/// A `## <slug> [<status>]` section per ticket, echoing the shape of the
/// `consult` markdown output so a resuming skill can read it directly.
fn print_markdown(tickets: &[Ticket]) {
    println!(
        "<!-- vault-query tickets: {} ticket(s) -->\n",
        tickets.len()
    );
    for t in tickets {
        let ident = if t.slug.is_empty() { &t.path } else { &t.slug };
        println!("## {ident} [{}]", t.status);
        println!();
        if !t.description.is_empty() {
            println!("{}\n", t.description);
        }
        println!("- path: {}", t.path);
        if !t.project.is_empty() {
            println!("- project: {}", t.project);
        }
        println!(
            "- track: {}",
            if t.track.is_empty() { "—" } else { &t.track }
        );
        let requires = if t.requires.is_empty() {
            "—".to_string()
        } else {
            t.requires.join(", ")
        };
        println!("- requires: {requires}\n");
    }
}

fn print_json(tickets: &[Ticket]) -> Result<()> {
    let envelope = TicketsOutput {
        count: tickets.len(),
        tickets,
    };
    println!("{}", serde_json::to_string_pretty(&envelope)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault_ignore::VaultIgnore;
    use tempfile::TempDir;

    /// Build a temp vault under `41 projects/nix/` with a claimed ticket, an
    /// unclaimed open ticket (the backlog case), a done ticket, a template
    /// ticket (excluded), and a plain note (excluded).
    fn build_ticket_vault() -> TempDir {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("41 projects/nix");
        std::fs::create_dir_all(&dir).unwrap();

        std::fs::write(
            dir.join("ticket-claimed.md"),
            "---\ntype: ticket\nslug: claimed\ndescription: A claimed ticket\nstatus: open\n\
             track: \"[[41 projects/nix/track-work-tracking-model]]\"\nrequires: []\n---\nbody\n",
        )
        .unwrap();

        std::fs::write(
            dir.join("ticket-backlog.md"),
            "---\ntype: ticket\nslug: backlog\ndescription: An unclaimed open ticket\nstatus: open\n\
             track:\nrequires:\n  - \"[[41 projects/nix/ticket-claimed]]\"\n---\nbody\n",
        )
        .unwrap();

        std::fs::write(
            dir.join("ticket-done.md"),
            "---\ntype: ticket\nslug: done\ndescription: A finished ticket\nstatus: done\n\
             track:\nrequires: []\n---\nbody\n",
        )
        .unwrap();

        std::fs::write(
            dir.join("ticket-template.md"),
            "---\ntype: ticket\ntemplate: true\nslug: tmpl\nstatus: open\ntrack:\n---\nbody\n",
        )
        .unwrap();

        std::fs::write(
            dir.join("just-a-note.md"),
            "---\ntype: note\nslug: note\n---\nbody\n",
        )
        .unwrap();

        tmp
    }

    fn scan_vault(root: &Path) -> Vec<VaultFile> {
        vault::scan(root, root, Some(&VaultIgnore::from_patterns(vec![]))).unwrap()
    }

    fn slugs(tickets: &[Ticket]) -> Vec<String> {
        tickets.iter().map(|t| t.slug.clone()).collect()
    }

    #[test]
    fn no_filter_lists_all_tickets_excluding_template_and_note() {
        let tmp = build_ticket_vault();
        let files = scan_vault(tmp.path());
        let tickets = select(
            &files,
            tmp.path(),
            DEFAULT_PROJECTS_PATH,
            None,
            None,
            false,
            None,
        );
        // ordered by path: ticket-backlog, ticket-claimed, ticket-done
        assert_eq!(slugs(&tickets), vec!["backlog", "claimed", "done"]);
    }

    #[test]
    fn track_filter_resolves_backref_stem() {
        let tmp = build_ticket_vault();
        let files = scan_vault(tmp.path());
        let tickets = select(
            &files,
            tmp.path(),
            DEFAULT_PROJECTS_PATH,
            None,
            Some("work-tracking-model"),
            false,
            None,
        );
        assert_eq!(slugs(&tickets), vec!["claimed"]);
        assert_eq!(tickets[0].track, "work-tracking-model");
        assert_eq!(tickets[0].requires, Vec::<String>::new());
    }

    #[test]
    fn track_filter_no_match_is_empty() {
        let tmp = build_ticket_vault();
        let files = scan_vault(tmp.path());
        let tickets = select(
            &files,
            tmp.path(),
            DEFAULT_PROJECTS_PATH,
            None,
            Some("nonexistent-track"),
            false,
            None,
        );
        assert!(tickets.is_empty());
    }

    #[test]
    fn backlog_filter_is_unclaimed_and_open() {
        let tmp = build_ticket_vault();
        let files = scan_vault(tmp.path());
        let tickets = select(
            &files,
            tmp.path(),
            DEFAULT_PROJECTS_PATH,
            None,
            None,
            true,
            None,
        );
        // claimed excluded (has a track); done excluded (status != open).
        assert_eq!(slugs(&tickets), vec!["backlog"]);
        assert!(tickets[0].track.is_empty());
        assert_eq!(tickets[0].requires, vec!["ticket-claimed"]);
    }

    #[test]
    fn status_filter_open() {
        let tmp = build_ticket_vault();
        let files = scan_vault(tmp.path());
        let tickets = select(
            &files,
            tmp.path(),
            DEFAULT_PROJECTS_PATH,
            None,
            None,
            false,
            Some("open"),
        );
        assert_eq!(slugs(&tickets), vec!["backlog", "claimed"]);
    }

    #[test]
    fn status_filter_done() {
        let tmp = build_ticket_vault();
        let files = scan_vault(tmp.path());
        let tickets = select(
            &files,
            tmp.path(),
            DEFAULT_PROJECTS_PATH,
            None,
            None,
            false,
            Some("done"),
        );
        assert_eq!(slugs(&tickets), vec!["done"]);
    }

    #[test]
    fn project_scope_matches_and_excludes() {
        let tmp = build_ticket_vault();
        let files = scan_vault(tmp.path());
        let in_scope = tmp.path().join("41 projects/nix");
        let tickets = select(
            &files,
            tmp.path(),
            DEFAULT_PROJECTS_PATH,
            Some(&in_scope),
            None,
            false,
            None,
        );
        assert_eq!(tickets.len(), 3);
        assert_eq!(tickets[0].project, "nix");

        let out_scope = tmp.path().join("41 projects/other");
        let none = select(
            &files,
            tmp.path(),
            DEFAULT_PROJECTS_PATH,
            Some(&out_scope),
            None,
            false,
            None,
        );
        assert!(none.is_empty());
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

    #[test]
    fn project_helper_derives_folder_not_bare_file() {
        assert_eq!(
            ticket_project("41 projects/nix/ticket-x.md", "41 projects"),
            "nix"
        );
        // A ticket directly under projects_path has no project folder.
        assert_eq!(ticket_project("41 projects/ticket-x.md", "41 projects"), "");
        assert_eq!(ticket_project("20 cards/foo.md", "41 projects"), "");
    }
}
