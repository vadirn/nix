pub mod filter;
pub mod formula;
pub mod view;

use anyhow::Result;
use serde::Deserialize;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

/// A parsed .base file.
#[derive(Debug, Clone)]
pub struct BaseFile {
    pub filters: FilterSet,
    pub formulas: BTreeMap<String, String>,
    pub properties: BTreeMap<String, PropertyDef>,
    pub views: Vec<ViewDef>,
}

/// Filter set: and/or combinators.
#[derive(Debug, Clone, Default)]
pub struct FilterSet {
    pub and: Vec<String>,
    pub or: Vec<String>,
}

/// Property definition with display name.
#[derive(Debug, Clone)]
pub struct PropertyDef {
    pub display_name: String,
}

/// View definition.
#[derive(Debug, Clone)]
pub struct ViewDef {
    pub name: String,
    pub filters: FilterSet,
    pub order: Vec<String>,
    pub sort: Vec<SortDef>,
    pub group_by: Option<GroupByDef>,
    pub summaries: BTreeMap<String, String>,
}

#[derive(Debug, Clone)]
pub struct SortDef {
    pub property: String,
    pub direction: SortDirection,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SortDirection {
    ASC,
    DESC,
}

#[derive(Debug, Clone)]
pub struct GroupByDef {
    pub property: String,
    pub direction: SortDirection,
}

// --- Raw deserialization types ---

#[derive(Deserialize)]
struct RawBase {
    filters: Option<RawFilterSet>,
    properties: Option<BTreeMap<String, RawPropertyDef>>,
    views: Option<Vec<RawViewDef>>,
}

#[derive(Deserialize)]
struct RawFilterSet {
    and: Option<Vec<String>>,
    or: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct RawPropertyDef {
    #[serde(rename = "displayName")]
    display_name: Option<String>,
}

#[derive(Deserialize)]
struct RawViewDef {
    name: Option<String>,
    filters: Option<RawFilterSet>,
    order: Option<Vec<String>>,
    sort: Option<Vec<RawSortDef>>,
    #[serde(rename = "groupBy")]
    group_by: Option<RawGroupByDef>,
    summaries: Option<BTreeMap<String, String>>,
    #[serde(rename = "type")]
    _type: Option<String>,
    #[serde(rename = "columnSize")]
    _column_size: Option<BTreeMap<String, serde_yaml::Value>>,
}

#[derive(Deserialize)]
struct RawSortDef {
    property: String,
    direction: Option<String>,
}

#[derive(Deserialize)]
struct RawGroupByDef {
    property: String,
    direction: Option<String>,
}

fn parse_direction(s: Option<&str>) -> SortDirection {
    match s {
        Some("ASC") => SortDirection::ASC,
        _ => SortDirection::DESC,
    }
}

fn convert_filters(raw: Option<RawFilterSet>) -> FilterSet {
    match raw {
        Some(f) => FilterSet {
            and: f.and.unwrap_or_default(),
            or: f.or.unwrap_or_default(),
        },
        None => FilterSet::default(),
    }
}

/// Parse a .base file from a path.
pub fn parse(path: &Path) -> Result<BaseFile> {
    let content = fs::read_to_string(path)?;
    parse_str(&content)
}

/// Extract the formulas block from .base content before YAML parsing.
/// Formula values contain YAML-hostile characters (parens, colons, quotes).
/// Returns (formulas map, content with formulas block removed).
fn extract_formulas(content: &str) -> (BTreeMap<String, String>, String) {
    let mut formulas = BTreeMap::new();
    let mut remaining = Vec::new();
    let mut in_formulas = false;

    for line in content.lines() {
        if line == "formulas:" || line.starts_with("formulas:") && line.trim() == "formulas:" {
            in_formulas = true;
            continue;
        }
        if in_formulas {
            if !line.is_empty() && !line.starts_with(' ') && !line.starts_with('\t') {
                in_formulas = false;
                remaining.push(line);
            } else if !line.trim().is_empty() {
                let trimmed = line.trim();
                if let Some(colon_pos) = trimmed.find(": ") {
                    let key = trimmed[..colon_pos].to_string();
                    let value = trimmed[colon_pos + 2..].to_string();
                    formulas.insert(key, value);
                }
            }
        } else {
            remaining.push(line);
        }
    }

    (formulas, remaining.join("\n"))
}

/// Parse a .base file from a string.
pub fn parse_str(content: &str) -> Result<BaseFile> {
    let (formulas, yaml_content) = extract_formulas(content);
    let raw: RawBase = serde_yaml::from_str(&yaml_content)?;

    let filters = convert_filters(raw.filters);

    let properties = raw
        .properties
        .unwrap_or_default()
        .into_iter()
        .map(|(k, v)| {
            (
                k,
                PropertyDef {
                    display_name: v.display_name.unwrap_or_default(),
                },
            )
        })
        .collect();

    let views = raw
        .views
        .unwrap_or_default()
        .into_iter()
        .map(|v| ViewDef {
            name: v.name.unwrap_or_default(),
            filters: convert_filters(v.filters),
            order: v.order.unwrap_or_default(),
            sort: v
                .sort
                .unwrap_or_default()
                .into_iter()
                .map(|s| SortDef {
                    property: s.property,
                    direction: parse_direction(s.direction.as_deref()),
                })
                .collect(),
            group_by: v.group_by.map(|g| GroupByDef {
                property: g.property,
                direction: parse_direction(g.direction.as_deref()),
            }),
            summaries: v.summaries.unwrap_or_default(),
        })
        .collect();

    Ok(BaseFile {
        filters,
        formulas,
        properties,
        views,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_checkpoints_base() {
        let content = r#"
filters:
  and:
    - type == "checkpoint"
    - file.inFolder("41 projects/nix")
formulas:
  cost_per_line: if(lines_written > 0, (cost_usd / lines_written).round(3), "")
properties:
  file.name:
    displayName: Checkpoint
  note.description:
    displayName: Description
views:
  - type: table
    name: All
    order:
      - file.name
      - description
      - done
    sort:
      - property: file.name
        direction: DESC
  - type: table
    name: Incomplete
    filters:
      and:
        - done == false
    order:
      - file.name
      - description
    sort:
      - property: file.name
        direction: DESC
"#;
        let base = parse_str(content).unwrap();
        assert_eq!(base.filters.and.len(), 2);
        assert_eq!(base.filters.and[0], "type == \"checkpoint\"");
        assert_eq!(base.formulas.len(), 1);
        assert!(base.formulas.contains_key("cost_per_line"));
        assert_eq!(base.properties.len(), 2);
        assert_eq!(
            base.properties.get("file.name").unwrap().display_name,
            "Checkpoint"
        );
        assert_eq!(base.views.len(), 2);
        assert_eq!(base.views[0].name, "All");
        assert_eq!(base.views[1].name, "Incomplete");
        assert_eq!(base.views[1].filters.and.len(), 1);
    }

    #[test]
    fn test_parse_projects_base() {
        let content = r#"
filters:
  and:
    - type == "project"
    - '!file.inFolder("templates")'
formulas:
  status_order: if(status == "planned", "1 planned", if(status == "in progress", "2 in progress", if(status == "done", "3 done", "4 archived")))
properties:
  file.name:
    displayName: Проект
  note.status:
    displayName: Статус
views:
  - type: table
    name: Все проекты
    groupBy:
      property: formula.status_order
      direction: ASC
    order:
      - file.name
      - status
      - deadline
    sort:
      - property: deadline
        direction: ASC
  - type: table
    name: Активные проекты
    filters:
      and:
        - status.containsAny("in progress", "planned")
    groupBy:
      property: formula.status_order
      direction: ASC
    order:
      - file.name
      - status
      - deadline
    sort:
      - property: deadline
        direction: ASC
"#;
        let base = parse_str(content).unwrap();
        assert_eq!(base.filters.and.len(), 2);
        assert!(base.formulas.contains_key("status_order"));
        assert_eq!(base.views.len(), 2);
        assert!(base.views[0].group_by.is_some());
        let gb = base.views[0].group_by.as_ref().unwrap();
        assert_eq!(gb.property, "formula.status_order");
        assert_eq!(gb.direction, SortDirection::ASC);
    }
}
