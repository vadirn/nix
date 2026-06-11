use anyhow::Result;

use crate::{frontmatter, vault};

/// Return true if the file at `full_path` is superseded (frontmatter `superseded: true`
/// or `type: checkpoint`). Returns false if the file cannot be read or parsed.
fn path_is_superseded(full_path: &std::path::Path) -> bool {
    let Ok(content) = std::fs::read_to_string(full_path) else {
        return false;
    };
    let fm = frontmatter::parse(&content)
        .unwrap_or(None)
        .unwrap_or_default();
    let file_type = frontmatter::get_display(&fm, "type");
    frontmatter::is_superseded(&fm) || file_type == "checkpoint"
}

pub fn run(fragment: &str, cfg: &crate::config::ResolvedConfig, no_superseded: bool) -> Result<()> {
    let vault_root = &cfg.vault_root;
    let mut paths = resolve_paths(fragment, cfg)?;

    // Apply --no-superseded filter before branching on path count so that a single
    // surviving non-superseded match resolves normally instead of falling through to
    // the multi-match listing or the no-match exit.
    if no_superseded {
        paths.retain(|p| !path_is_superseded(&vault_root.join(p)));
    }

    if paths.is_empty() {
        eprintln!("No matches for '{}'", fragment);
        std::process::exit(1);
    } else if paths.len() == 1 {
        let full = vault_root.join(&paths[0]);
        let content = std::fs::read_to_string(&full)?;

        // Determine if the resolved entry is superseded.
        let fm = frontmatter::parse(&content)
            .unwrap_or(None)
            .unwrap_or_default();
        let file_type = frontmatter::get_display(&fm, "type");
        let is_sup = frontmatter::is_superseded(&fm) || file_type == "checkpoint";

        // With --no-superseded the path was already filtered out above, so this
        // branch only triggers for the single-match case without the flag, or for a
        // superseded single match when the flag is absent.
        if no_superseded && is_sup {
            eprintln!("Entry is superseded. Use without --no-superseded to retrieve it.");
            std::process::exit(1);
        }

        println!("{}", full.display());
        if is_sup {
            println!("[superseded]");
        }
        println!("---");
        print!("{}", content);
    } else {
        // Multi-match: list all candidates. Append [superseded] label where applicable.
        for p in &paths {
            let full = vault_root.join(p);
            let sup_label = if path_is_superseded(&full) { " [superseded]" } else { "" };
            println!("{}{}", full.display(), sup_label);
        }
    }
    Ok(())
}

/// Resolve a slug to matching relative paths (reusable by other commands).
pub fn resolve_paths(slug: &str, cfg: &crate::config::ResolvedConfig) -> Result<Vec<String>> {
    let vault_root = &cfg.vault_root;
    let files = vault::scan(vault_root, vault_root, Some(&cfg.ignore))?;
    let needle = slugify(slug);
    let mut matches = Vec::new();

    for file in &files {
        let rel = file.relative_path(vault_root);
        let slugified = slugify(strip_md(&rel));

        let is_match = slugified == needle
            || slugified
                .strip_suffix(&needle)
                .is_some_and(|prefix| prefix.ends_with('/'));

        if is_match {
            matches.push(rel);
        }
    }
    Ok(matches)
}

fn slugify(s: &str) -> String {
    s.to_lowercase().replace(' ', "-")
}

fn strip_md(s: &str) -> &str {
    s.strip_suffix(".md").unwrap_or(s)
}
