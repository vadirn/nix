use anyhow::Result;

pub fn run(slug: &str, cfg: &crate::config::ResolvedConfig) -> Result<bool> {
    let matches = crate::slug::resolve_paths(slug, cfg)?;
    for rel in &matches {
        println!("{}", rel);
    }
    Ok(!matches.is_empty())
}
