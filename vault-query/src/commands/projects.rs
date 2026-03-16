use anyhow::Result;

use crate::config::ResolvedConfig;
use crate::output::Format;

pub fn run(cfg: &ResolvedConfig, view: &str) -> Result<()> {
    let base_path = cfg.vault_root.join("90 bases/Projects.base");

    if base_path.is_file() {
        return super::query::run(&base_path, view, &cfg.vault_root, Format::Table);
    }

    // Fallback: file listing
    eprintln!("# Fallback: file-based project listing");
    let projects_dir = cfg.vault_root.join("41 projects");
    if !projects_dir.is_dir() {
        return Ok(());
    }

    let mut entries: Vec<_> = walkdir::WalkDir::new(&projects_dir)
        .max_depth(2)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            let path = e.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("md") {
                return false;
            }
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            !name.starts_with("checkpoint-")
                && name != "context.md"
                && name != "SKILL.md"
                && name != "start.md"
                && name != "save.md"
        })
        .map(|e| e.path().to_path_buf())
        .collect();
    entries.sort();
    for entry in entries {
        println!("{}", entry.display());
    }
    Ok(())
}
