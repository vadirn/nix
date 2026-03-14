use anyhow::Result;
use regex::Regex;
use std::path::Path;

use crate::vault;

pub fn run(query: &str, vault_root: &Path, context: usize, subfolder: Option<&Path>) -> Result<()> {
    let re = Regex::new(query)?;

    let root = match subfolder {
        Some(folder) => vault_root.join(folder),
        None => vault_root.to_path_buf(),
    };

    let files = vault::scan(&root)?;

    for file in &files {
        let lines: Vec<&str> = file.content.lines().collect();
        let mut printed_header = false;

        for (i, line) in lines.iter().enumerate() {
            if re.is_match(line) {
                if !printed_header {
                    let rel = file.relative_path(vault_root);
                    println!("{}:", rel);
                    printed_header = true;
                }

                let start = i.saturating_sub(context);
                let end = (i + context + 1).min(lines.len());

                for j in start..end {
                    let marker = if j == i { ">" } else { " " };
                    println!("{} {:4}: {}", marker, j + 1, lines[j]);
                }
                println!();
            }
        }
    }
    Ok(())
}
