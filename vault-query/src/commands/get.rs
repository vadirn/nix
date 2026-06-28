use anyhow::{Context, Result};

use crate::frontmatter;

/// Return true if the file at `full_path` is bottom-tier (legacy `superseded: true`,
/// `type: checkpoint`, or `epistemic_status: superseded`).
///
/// Propagates IO and parse failures instead of swallowing them to `false`: a file
/// the caller was told to exclude under `--no-superseded` must not slip through as
/// live just because it could not be read or parsed.
fn path_is_bottom_tier(full_path: &std::path::Path) -> Result<bool> {
    let content = std::fs::read_to_string(full_path)
        .with_context(|| format!("reading {}", full_path.display()))?;
    let fm = frontmatter::parse(&content)
        .with_context(|| format!("parsing frontmatter of {}", full_path.display()))?
        .unwrap_or_default();
    Ok(crate::epistemic::epistemic_tier(&fm).is_bottom())
}

pub fn run(fragment: &str, cfg: &crate::config::ResolvedConfig, no_superseded: bool) -> Result<()> {
    let vault_root = &cfg.vault_root;
    let mut paths = crate::slug::resolve_paths(fragment, cfg)?;

    // Apply --no-superseded filter before branching on path count so that a single
    // surviving non-superseded match resolves normally instead of falling through to
    // the multi-match listing or the no-match exit.
    if no_superseded {
        let mut kept = Vec::with_capacity(paths.len());
        for p in paths {
            if !path_is_bottom_tier(&vault_root.join(&p))? {
                kept.push(p);
            }
        }
        paths = kept;
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
