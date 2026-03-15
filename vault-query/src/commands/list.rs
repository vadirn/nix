use anyhow::Result;
use std::path::Path;

use crate::frontmatter;
use crate::vault;
use crate::wikilink;

/// List markdown files in a folder with frontmatter metadata.
/// Output format: `title — description [tags] (field: value)`
pub fn run(vault_root: &Path, folder: &str, fields: &[String]) -> Result<()> {
    let files = vault::scan(vault_root)?;
    let mut matching: Vec<_> = files
        .iter()
        .filter(|f| f.in_folder(folder, vault_root))
        .collect();
    matching.sort_by(|a, b| a.name.cmp(&b.name));

    for file in matching {
        let desc = frontmatter::get_display(&file.frontmatter, "description");
        let tags = frontmatter::get_display(&file.frontmatter, "tags");

        let mut line = file.name.clone();
        if !desc.is_empty() {
            line.push_str(" — ");
            line.push_str(&desc);
        }
        if !tags.is_empty() {
            line.push_str(" [");
            line.push_str(&tags);
            line.push(']');
        }
        for field in fields {
            let val = frontmatter::get_display(&file.frontmatter, field);
            if val.is_empty() {
                continue;
            }
            let stripped = wikilink::strip(&val);
            line.push_str(" (");
            line.push_str(field);
            line.push_str(": ");
            line.push_str(&stripped);
            line.push(')');
        }
        println!("{}", line);
    }
    Ok(())
}
