use anyhow::Result;

use crate::vault;

fn slugify(s: &str) -> String {
    s.to_lowercase().replace(' ', "-")
}

fn strip_md(s: &str) -> &str {
    s.strip_suffix(".md").unwrap_or(s)
}

pub fn run(slug: &str, cfg: &crate::config::ResolvedConfig) -> Result<bool> {
    let vault_root = &cfg.vault_root;
    let files = vault::scan(vault_root, vault_root, Some(&cfg.ignore))?;
    let needle = slugify(slug);
    let mut found = false;

    for file in &files {
        let rel = file.relative_path(vault_root);
        let slugified = slugify(strip_md(&rel));

        let is_match = slugified == needle
            || slugified
                .strip_suffix(&needle)
                .is_some_and(|prefix| prefix.ends_with('/'));

        if is_match {
            println!("{}", rel);
            found = true;
        }
    }

    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_slugify() {
        assert_eq!(slugify("41 projects/nix"), "41-projects/nix");
        assert_eq!(slugify("Impureim sandwich"), "impureim-sandwich");
        assert_eq!(slugify("already-lowercase"), "already-lowercase");
    }

    #[test]
    fn test_strip_md() {
        assert_eq!(strip_md("file.md"), "file");
        assert_eq!(strip_md("no-extension"), "no-extension");
        assert_eq!(strip_md("double.md.md"), "double.md");
    }
}
