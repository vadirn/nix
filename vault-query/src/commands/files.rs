use anyhow::Result;
use std::path::Path;

use crate::{frontmatter, vault};

pub fn run(cfg: &crate::config::ResolvedConfig, folder: Option<&Path>, count: bool, tag: Option<&str>) -> Result<()> {
    let vault_root = &cfg.vault_root;
    let root = vault::resolve_root(vault_root, folder);

    let files = vault::scan(&root, vault_root, Some(&cfg.ignore))?;

    let files: Vec<_> = if let Some(tag) = tag {
        files
            .into_iter()
            .filter(|f| frontmatter::contains_any(&f.frontmatter, "tags", &[tag]))
            .collect()
    } else {
        files
    };

    if count {
        println!("{}", files.len());
    } else {
        let mut names: Vec<String> = files
            .iter()
            .map(|f| f.relative_path(vault_root))
            .collect();
        names.sort();
        for name in names {
            println!("{}", name);
        }
    }
    Ok(())
}
