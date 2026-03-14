use anyhow::Result;
use std::path::Path;

use crate::vault;
use crate::wikilink;

pub fn run(file: &Path, vault_root: &Path) -> Result<()> {
    let target_name = file
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| anyhow::anyhow!("invalid file path"))?;

    let files = vault::scan(vault_root)?;
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
