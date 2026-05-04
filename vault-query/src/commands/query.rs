use anyhow::Result;
use std::path::Path;

use crate::base;
use crate::base::filter;
use crate::base::view;
use crate::output::{self, Format};
use crate::vault;

pub fn run(base_path: &Path, view_name: &str, cfg: &crate::config::ResolvedConfig, format: Format) -> Result<()> {
    let vault_root = &cfg.vault_root;
    let base_file = base::parse(base_path)?;

    let target_view = base_file
        .views
        .iter()
        .find(|v| v.name == view_name)
        .ok_or_else(|| {
            let available: Vec<&str> = base_file.views.iter().map(|v| v.name.as_str()).collect();
            anyhow::anyhow!(
                "view '{}' not found. Available: {}",
                view_name,
                available.join(", ")
            )
        })?
        .clone();

    let all_files = vault::scan(vault_root, vault_root, Some(&cfg.ignore))?;

    let mut filtered = filter::apply(
        &all_files,
        &base_file.filters,
        &target_view.filters,
        vault_root,
    );

    let result = view::apply(&target_view, &base_file, &mut filtered);
    print!("{}", output::render(&result, &format));

    Ok(())
}
