//! `tracks` — a view into the project's `Tracks.base`.
//!
//! All the plumbing lives in [`super::project_base`]; what stays here is the
//! constants that make this base a track base rather than a ticket one.

use anyhow::Result;

use crate::commands::project_base::ProjectBase;
use crate::config::ResolvedConfig;
use crate::output::Format;

const BASE: ProjectBase = ProjectBase {
    file_name: "Tracks.base",
    init_command: "tracks-init",
    template: render_template,
};

pub fn run(cfg: &ResolvedConfig, view: &str, format: Format) -> Result<()> {
    BASE.run(cfg, view, format, None)
}

pub fn init(cfg: &ResolvedConfig) -> Result<()> {
    BASE.init(cfg)
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
