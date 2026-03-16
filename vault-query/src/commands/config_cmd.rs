use anyhow::Result;

use crate::config::ResolvedConfig;

pub fn run(cfg: &ResolvedConfig) -> Result<()> {
    let mut map = serde_json::Map::new();
    map.insert(
        "vault_root".into(),
        serde_json::Value::String(cfg.vault_root.to_string_lossy().into()),
    );
    if let Some(ref pp) = cfg.projects_path {
        map.insert(
            "projects_path".into(),
            serde_json::Value::String(pp.clone()),
        );
    }
    if let Some(ref p) = cfg.project_path {
        map.insert(
            "project_path".into(),
            serde_json::Value::String(p.to_string_lossy().into()),
        );
    }
    println!("{}", serde_json::to_string_pretty(&map)?);
    Ok(())
}
