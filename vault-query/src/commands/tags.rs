use anyhow::Result;
use serde_yaml::Value;
use std::collections::BTreeMap;
use std::path::Path;

use crate::vault;

pub fn run(vault_root: &Path, sort: &str) -> Result<()> {
    let files = vault::scan(vault_root)?;
    let mut tag_counts: BTreeMap<String, usize> = BTreeMap::new();

    for file in &files {
        if let Some(Value::Sequence(tags)) = file.frontmatter.get("tags") {
            for tag in tags {
                if let Value::String(t) = tag {
                    *tag_counts.entry(t.clone()).or_insert(0) += 1;
                }
            }
        }
    }

    let mut entries: Vec<(String, usize)> = tag_counts.into_iter().collect();
    match sort {
        "count" => entries.sort_by(|a, b| b.1.cmp(&a.1)),
        _ => entries.sort_by(|a, b| a.0.cmp(&b.0)),
    }

    for (tag, count) in entries {
        println!("{}\t{}", tag, count);
    }
    Ok(())
}
