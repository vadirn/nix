use anyhow::{bail, Context, Result};

use crate::config::ResolvedConfig;
use crate::output::Format;

pub fn run(cfg: &ResolvedConfig, view: &str, format: Format) -> Result<()> {
    let project_path = cfg
        .project_path
        .as_ref()
        .context("no project resolved (use --project <name> or add .vault.config.json)")?;

    let base_path = project_path.join("Tracks.base");
    if !base_path.is_file() {
        bail!("no Tracks.base in {}", project_path.display());
    }
    super::query::run(&base_path, view, cfg, format)
}

pub fn init(cfg: &ResolvedConfig) -> Result<()> {
    let project_path = cfg
        .project_path
        .as_ref()
        .context("no project resolved (use --project <name> or add .vault.config.json)")?;

    let base_path = project_path.join("Tracks.base");
    if base_path.exists() {
        bail!("Tracks.base already exists at {}", base_path.display());
    }

    let folder = project_path
        .strip_prefix(&cfg.vault_root)
        .with_context(|| {
            format!(
                "project_path {} is not inside vault_root {}",
                project_path.display(),
                cfg.vault_root.display()
            )
        })?
        .to_string_lossy()
        .replace('\\', "/");

    let content = render_template(&folder);
    std::fs::write(&base_path, content)
        .with_context(|| format!("writing {}", base_path.display()))?;
    println!("created {}", base_path.display());
    Ok(())
}

fn render_template(folder: &str) -> String {
    format!(
        r#"filters:
  and:
    - type == "track"
    - file.inFolder("{folder}")
properties:
  file.name:
    displayName: Track
  note.slug:
    displayName: Slug
  note.status:
    displayName: Status
  note.description:
    displayName: Description
  note.updated:
    displayName: Updated
views:
  - type: table
    name: Active
    filters:
      and:
        - status.containsAny("open", "paused")
    order:
      - file.name
      - status
      - description
      - updated
    sort:
      - property: updated
        direction: DESC
  - type: table
    name: Open
    filters:
      and:
        - status == "open"
    order:
      - file.name
      - status
      - description
      - updated
    sort:
      - property: updated
        direction: DESC
  - type: table
    name: Paused
    filters:
      and:
        - status == "paused"
    order:
      - file.name
      - status
      - description
      - updated
    sort:
      - property: updated
        direction: DESC
  - type: table
    name: Done
    filters:
      and:
        - status == "done"
    order:
      - file.name
      - status
      - description
      - updated
    sort:
      - property: updated
        direction: DESC
  - type: table
    name: Abandoned
    filters:
      and:
        - status == "abandoned"
    order:
      - file.name
      - status
      - description
      - updated
    sort:
      - property: updated
        direction: DESC
  - type: table
    name: Superseded
    filters:
      and:
        - status == "superseded"
    order:
      - file.name
      - status
      - description
      - updated
    sort:
      - property: updated
        direction: DESC
  - type: table
    name: All
    order:
      - file.name
      - status
      - description
      - updated
    sort:
      - property: updated
        direction: DESC
  - type: table
    name: Stats
    order:
      - file.name
      - status
      - description
      - updated
    sort:
      - property: updated
        direction: DESC
    groupBy:
      property: status
      direction: ASC
"#
    )
}
