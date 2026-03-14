use anyhow::Result;
use std::path::Path;

use crate::vault;
use crate::wikilink;

pub fn run(vault_root: &Path) -> Result<()> {
    let files = vault::scan(vault_root)?;
    let index = wikilink::build_backlink_index(&files);

    let mut orphans: Vec<&str> = files
        .iter()
        .filter(|f| !index.contains_key(&f.name.to_lowercase()))
        .map(|f| f.name.as_str())
        .collect();
    orphans.sort();

    for name in orphans {
        println!("{}", name);
    }
    Ok(())
}
