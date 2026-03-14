use anyhow::Result;
use std::fs;
use std::path::Path;

use crate::frontmatter;
use crate::output::{self, Format};

pub fn run(file: &Path, format: Format) -> Result<()> {
    let content = fs::read_to_string(file)?;
    let fm = frontmatter::parse(&content)?
        .ok_or_else(|| anyhow::anyhow!("no frontmatter found in {}", file.display()))?;

    let properties: Vec<(String, String)> = fm
        .iter()
        .map(|(k, v)| (k.clone(), frontmatter::value_to_display(v)))
        .collect();

    println!("{}", output::render_properties(&properties, &format));
    Ok(())
}
