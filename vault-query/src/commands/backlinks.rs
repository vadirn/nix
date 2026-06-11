use anyhow::Result;
use std::path::Path;

use crate::{frontmatter, vault};
use crate::wikilink;

pub fn run(file: &Path, cfg: &crate::config::ResolvedConfig, no_superseded: bool) -> Result<()> {
    let vault_root = &cfg.vault_root;
    let target_name = file
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| anyhow::anyhow!("invalid file path"))?;

    let files = vault::scan(vault_root, vault_root, Some(&cfg.ignore))?;

    // Build a name → VaultFile lookup so we can check each source's superseded state.
    let file_by_name: std::collections::HashMap<String, &vault::VaultFile> = files
        .iter()
        .map(|f| (f.name.clone(), f))
        .collect();

    let index = wikilink::build_backlink_index(&files);

    let key = target_name.to_lowercase();
    match index.get(&key) {
        Some(sources) => {
            for source in sources {
                let is_sup = file_by_name
                    .get(source)
                    .map(|vf| {
                        frontmatter::is_superseded(&vf.frontmatter)
                            || frontmatter::get_display(&vf.frontmatter, "type") == "checkpoint"
                    })
                    .unwrap_or(false);

                if no_superseded && is_sup {
                    continue;
                }

                if is_sup {
                    println!("[superseded] {}", source);
                } else {
                    println!("{}", source);
                }
            }
        }
        None => {
            eprintln!("no backlinks found for {}", target_name);
        }
    }
    Ok(())
}
