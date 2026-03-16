use anyhow::Result;

use crate::config::ResolvedConfig;

pub fn run(cfg: &ResolvedConfig) -> Result<()> {
    let project_path = cfg
        .project_path
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("no project resolved (use --project <name> or add .claude/.vault.config.json)"))?;

    let context_file = project_path.join("context.md");
    if context_file.is_file() {
        let content = std::fs::read_to_string(&context_file)?;
        print!("{}", content);
    }
    // Silent if no context.md (matches bash behavior)
    Ok(())
}
