use anyhow::Result;

use crate::vault;



pub fn run(fragment: &str, cfg: &crate::config::ResolvedConfig) -> Result<()> {
    let vault_root = &cfg.vault_root;
    let paths = resolve_paths(fragment, cfg)?;

    if paths.is_empty() {
        eprintln!("No matches for '{}'", fragment);
        std::process::exit(1);
    } else if paths.len() == 1 {
        let full = vault_root.join(&paths[0]);
        println!("{}", full.display());
        println!("---");
        let content = std::fs::read_to_string(&full)?;
        print!("{}", content);
    } else {
        for p in &paths {
            println!("{}", vault_root.join(p).display());
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
