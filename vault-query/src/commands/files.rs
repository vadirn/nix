use anyhow::Result;
use std::path::Path;

use crate::vault;

pub fn run(vault_root: &Path, folder: Option<&Path>, count: bool) -> Result<()> {
    let root = vault::resolve_root(vault_root, folder);

    let files = vault::scan(&root)?;

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
