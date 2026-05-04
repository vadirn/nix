use anyhow::{bail, Context, Result};

use crate::config::ResolvedConfig;
use crate::output::Format;

pub fn run(cfg: &ResolvedConfig, view: &str, format: Format) -> Result<()> {
    let project_path = cfg
        .project_path
        .as_ref()
        .context("no project resolved (use --project <name> or add .vault.config.json)")?;

    let base_path = project_path.join("Checkpoints.base");
    if !base_path.is_file() {
        bail!("no Checkpoints.base in {}", project_path.display());
    }
    super::query::run(&base_path, view, cfg, format)
}
