use anyhow::Result;

/// Resolve `slug` to vault-relative path(s) and print them. Returns the process
/// exit code (0 when at least one match prints, 1 when none) so `main` owns the
/// single exit boundary instead of this command signalling through a bool.
pub fn run(slug: &str, cfg: &crate::config::ResolvedConfig) -> Result<i32> {
    let matches = crate::slug::resolve_paths(slug, cfg)?;
    for rel in &matches {
        println!("{}", rel);
    }
    Ok(if matches.is_empty() { 1 } else { 0 })
}
