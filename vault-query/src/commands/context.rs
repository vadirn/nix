use anyhow::Result;

use crate::config::ResolvedConfig;

/// The names a project's context file can carry, in preference order.
///
/// `Context.md` is what `project-setup` writes: a project folder holds exactly
/// one, so it is named like the other singletons beside it (`Tracks.base`,
/// the project note) rather than like the `<type>-<slug>` files.
///
/// The lowercase spelling predates that convention. macOS is case-insensitive
/// by default, so a single `join` would resolve either on this machine and fail
/// only once the vault reaches a case-sensitive one — checking both names keeps
/// that difference out of the result.
const CONTEXT_NAMES: [&str; 2] = ["Context.md", "context.md"];

pub fn run(cfg: &ResolvedConfig) -> Result<()> {
    let project_path = cfg.project_path.as_ref().ok_or_else(|| {
        anyhow::anyhow!("no project resolved (use --project <name> or add .vault.config.json)")
    })?;

    let found = CONTEXT_NAMES
        .iter()
        .map(|name| project_path.join(name))
        .find(|path| path.is_file());

    // Silent when a project declares no context file (matches bash behavior).
    if let Some(context_file) = found {
        let content = std::fs::read_to_string(&context_file)?;
        print!("{}", content);
    }
    Ok(())
}
