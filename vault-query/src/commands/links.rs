use anyhow::Result;
use std::fs;
use std::path::Path;

use crate::wikilink;

pub fn run(file: &Path) -> Result<()> {
    let content = fs::read_to_string(file)?;
    let links = wikilink::extract(&content);

    for link in links {
        let display = match &link.alias {
            Some(alias) => format!("{} -> {}", link.target, alias),
            None => link.target.clone(),
        };
        println!("{}", display);
    }
    Ok(())
}
