use anyhow::Result;

use crate::frontmatter;
use crate::vault::{self, VaultFile};
use crate::wikilink;

/// List markdown files in a folder with frontmatter metadata.
/// Output format: `title — description [tags] (field: value)`
pub fn run(cfg: &crate::config::ResolvedConfig, folder: &str, fields: &[String]) -> Result<()> {
    let vault_root = &cfg.vault_root;
    let files = vault::scan(vault_root, vault_root, Some(&cfg.ignore))?;
    let matching: Vec<&VaultFile> = files
        .iter()
        .filter(|f| f.in_folder(folder, vault_root))
        .collect();
    print_listing(matching, fields);
    Ok(())
}

/// List markdown files whose frontmatter `type` equals the given value.
/// Folder placement is irrelevant; the `type` key is the authoritative classifier.
/// Files marked `template: true` are excluded — templates carry the same `type`
/// as their instances but are not themselves instances.
pub fn run_by_type(cfg: &crate::config::ResolvedConfig, type_value: &str, fields: &[String]) -> Result<()> {
    let vault_root = &cfg.vault_root;
    let files = vault::scan(vault_root, vault_root, Some(&cfg.ignore))?;
    let matching: Vec<&VaultFile> = files
        .iter()
        .filter(|f| {
            frontmatter::get_display(&f.frontmatter, "type") == type_value
                && !frontmatter::is_template(&f.frontmatter)
        })
        .collect();
    print_listing(matching, fields);
    Ok(())
}

fn print_listing(mut files: Vec<&VaultFile>, fields: &[String]) {
    files.sort_by(|a, b| a.name.cmp(&b.name));

    for file in files {
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
}
