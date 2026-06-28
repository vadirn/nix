use anyhow::Result;

use crate::frontmatter;
use crate::vault::{self, VaultFile};
use crate::wikilink;

/// List markdown files in a folder with frontmatter metadata.
/// Output format: `title — description [tags] (field: value)`
pub fn run(cfg: &crate::config::ResolvedConfig, folder: &str, fields: &[String], no_superseded: bool) -> Result<()> {
    let vault_root = &cfg.vault_root;
    let files = vault::scan(vault_root, vault_root, Some(&cfg.ignore))?;
    let matching: Vec<&VaultFile> = files
        .iter()
        .filter(|f| {
            if !f.in_folder(folder, vault_root) {
                return false;
            }
            if no_superseded && is_entry_superseded(f) {
                return false;
            }
            true
        })
        .collect();
    print_listing(matching, fields);
    Ok(())
}

/// List markdown files whose frontmatter `type` equals the given value.
/// Folder placement is irrelevant; the `type` key is the authoritative classifier.
/// Files marked `template: true` are excluded — templates carry the same `type`
/// as their instances but are not themselves instances.
pub fn run_by_type(cfg: &crate::config::ResolvedConfig, type_value: &str, fields: &[String], no_superseded: bool) -> Result<()> {
    let vault_root = &cfg.vault_root;
    let files = vault::scan(vault_root, vault_root, Some(&cfg.ignore))?;
    let matching: Vec<&VaultFile> = files
        .iter()
        .filter(|f| {
            let file_type = frontmatter::get_display(&f.frontmatter, "type");
            if file_type != type_value {
                return false;
            }
            if frontmatter::is_template(&f.frontmatter) {
                return false;
            }
            if no_superseded && is_entry_superseded(f) {
                return false;
            }
            true
        })
        .collect();
    print_listing(matching, fields);
    Ok(())
}

/// Returns true when a VaultFile is bottom-tier (legacy `superseded: true`,
/// `type: checkpoint`, or `epistemic_status: superseded`). Delegates to the
/// canonical trust policy so list shares one definition with get/backlinks and
/// honors every bottom-tier signal, not just the legacy flag.
fn is_entry_superseded(f: &VaultFile) -> bool {
    crate::epistemic::epistemic_tier(&f.frontmatter).is_bottom()
}

fn print_listing(mut files: Vec<&VaultFile>, fields: &[String]) {
    files.sort_by(|a, b| a.name.cmp(&b.name));

    for file in files {
        let desc = frontmatter::get_display(&file.frontmatter, "description");
        let tags = frontmatter::get_display(&file.frontmatter, "tags");

        let sup_prefix = if is_entry_superseded(file) { "[superseded] " } else { "" };
        let mut line = format!("{}{}", sup_prefix, file.name);
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
