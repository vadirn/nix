use anyhow::Result;

use crate::frontmatter;

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
    let mut paths = crate::slug::resolve_paths(fragment, cfg)?;

    // Apply --no-superseded filter before branching on path count so that a single
    // surviving non-superseded match resolves normally instead of falling through to
    // the multi-match listing or the no-match exit.
    if no_superseded {
        paths.retain(|p| !path_is_superseded(&vault_root.join(p)));
    }

    if paths.is_empty() {
        eprintln!("No matches for '{}'", fragment);
        std::process::exit(1);
    }

    // `get` resolves a fragment to absolute path(s), one per line, and nothing else.
    // Reading is a separate concern: pipe the path into Read, `vault-query read`,
    // `cat`, or `distill-text`. Supersededness is gated by --no-superseded above.
    for p in &paths {
        println!("{}", vault_root.join(p).display());
    }
    Ok(())
}
