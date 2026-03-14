use anyhow::Result;
use std::collections::BTreeSet;
use std::path::Path;

use crate::vault;
use crate::wikilink;

pub fn run(vault_root: &Path) -> Result<()> {
    let files = vault::scan(vault_root)?;

    // Build set of existing note names (lowercase)
    let existing: BTreeSet<String> = files.iter().map(|f| f.name.to_lowercase()).collect();

    // Find all wikilinks pointing to nonexistent files
    let mut unresolved: BTreeSet<String> = BTreeSet::new();
    for file in &files {
        let links = wikilink::extract(&file.content);
        for link in links {
            let name = wikilink::resolve_name(&link.target).to_lowercase();
            if !existing.contains(&name) {
                unresolved.insert(link.target.clone());
            }
        }
    }

    for target in &unresolved {
        println!("{}", target);
    }
    Ok(())
}
