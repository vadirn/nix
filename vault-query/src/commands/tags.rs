use anyhow::Result;
use std::collections::BTreeMap;

use crate::frontmatter;
use crate::vault;

pub fn run(cfg: &crate::config::ResolvedConfig, sort: &str) -> Result<()> {
    let vault_root = &cfg.vault_root;
    let files = vault::scan(vault_root, vault_root, Some(&cfg.ignore))?;
    let mut tag_counts: BTreeMap<String, usize> = BTreeMap::new();

    for file in &files {
        for tag in frontmatter::get_string_seq(&file.frontmatter, "tags") {
            *tag_counts.entry(tag).or_insert(0) += 1;
        }
    }

    let mut entries: Vec<(String, usize)> = tag_counts.into_iter().collect();
    match sort {
        "count" => entries.sort_by(|a, b| b.1.cmp(&a.1)),
        _ => entries.sort_by(|a, b| a.0.cmp(&b.0)),
    }

    for (tag, count) in entries {
        println!("{}\t{}", tag, count);
    }
    Ok(())
}
