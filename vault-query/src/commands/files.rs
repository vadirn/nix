use anyhow::Result;
use std::path::Path;

use crate::vault;

pub fn run(vault_root: &Path, folder: Option<&Path>, count: bool) -> Result<()> {
    let root = match folder {
        Some(f) => vault_root.join(f),
        None => vault_root.to_path_buf(),
    };

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
