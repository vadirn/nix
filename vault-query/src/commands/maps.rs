//! `maps` — a view into the project's `Maps.base`.
//!
//! All the plumbing lives in [`super::project_base`]; what stays here is the
//! constants that make this base a map base rather than a track or ticket one.
//!
//! A map carries no `paused` status, so the view set is [`super::tracks`]'s
//! minus `Active` and `Paused`. `Open` is the default view for the same reason
//! `Active` is on tracks: it answers the question the command is asked.

use anyhow::Result;

use crate::commands::project_base::ProjectBase;
use crate::commands::query::Narrowing;
use crate::config::ResolvedConfig;
use crate::output::Format;

const BASE: ProjectBase = ProjectBase {
    file_name: "Maps.base",
    init_command: "maps-init",
    template: render_template,
};

/// Render one view of the project's `Maps.base`.
pub fn run(cfg: &ResolvedConfig, view: &str, format: Format) -> Result<()> {
    BASE.run(cfg, view, format, Narrowing::default())
}

/// Write the starter `Maps.base` into the resolved project.
pub fn init(cfg: &ResolvedConfig) -> Result<()> {
    BASE.init(cfg)
}

/// `ordering` and `crux` ride in every view's `order`, unlike the track columns.
/// They are what distinguishes a risk-ordered map from a dependency-ordered one,
/// and [`crate::base::view`] builds both the table headers and the `--format
/// json` keys from `order` alone — so a column absent there is absent from the
/// output whatever the file's frontmatter says.
fn render_template(folder: &str) -> String {
    format!(
        r#"filters:
  and:
    - type == "map"
    - file.inFolder("{folder}")
properties:
  file.name:
    displayName: Map
  note.slug:
    displayName: Slug
  note.status:
    displayName: Status
  note.ordering:
    displayName: Ordering
  note.crux:
    displayName: Crux
  note.description:
    displayName: Description
  note.updated:
    displayName: Updated
views:
  - type: table
    name: Open
    filters:
      and:
        - status == "open"
    order:
      - file.name
      - status
      - ordering
      - crux
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
      - ordering
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
      - ordering
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
      - ordering
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
      - ordering
      - crux
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
      - ordering
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::project_base::assert_template_views;

    #[test]
    fn template_parses_and_declares_every_documented_view() {
        assert_template_views(
            render_template,
            &["Open", "Done", "Abandoned", "Superseded", "All", "Stats"],
        );
    }

    /// The map status enum has no `paused`, so the track views that select it
    /// must not be copied across. A `Paused` view here would render empty
    /// forever, which reads as "no paused maps" rather than "no such status".
    #[test]
    fn template_declares_no_track_only_views() {
        let rendered = render_template("41 projects/nix");
        assert!(!rendered.contains("name: Active"), "{rendered}");
        assert!(!rendered.contains("name: Paused"), "{rendered}");
    }

    /// `ordering` and `crux` are the two columns a track base has no analogue
    /// for, and `view.rs` reads headers from `order` — so their presence in the
    /// properties block alone would not put them in the output.
    #[test]
    fn the_open_view_orders_the_columns_that_distinguish_a_map() {
        let rendered = render_template("41 projects/nix");
        let open = rendered
            .split("name: Open")
            .nth(1)
            .and_then(|rest| rest.split("- type: table").next())
            .expect("Open view");
        assert!(open.contains("- ordering"), "{open}");
        assert!(open.contains("- crux"), "{open}");
    }
}
