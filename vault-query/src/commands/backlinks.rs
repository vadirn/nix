use anyhow::Result;
use std::path::Path;

use crate::vault;
use crate::wikilink;

pub fn run(file: &Path, cfg: &crate::config::ResolvedConfig) -> Result<()> {
    let vault_root = &cfg.vault_root;
    let target_name = file
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| anyhow::anyhow!("invalid file path"))?;

    let files = vault::scan(vault_root, vault_root, cfg.ignore.as_ref())?;
    let index = wikilink::build_backlink_index(&files);

    let key = target_name.to_lowercase();
    match index.get(&key) {
        Some(sources) => {
            for source in sources {
                println!("{}", source);
            }
        }
        None => {
            eprintln!("no backlinks found for {}", target_name);
        }
    }
    Ok(())
}
