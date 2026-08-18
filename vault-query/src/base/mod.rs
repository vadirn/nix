pub mod column;
pub mod date;
pub mod filter;
pub mod formula;
pub mod parse;
pub mod view;

pub use parse::parse;

use std::collections::BTreeMap;

/// Whether a value counts as truthy: trim it, then call the empty string,
/// `false`, and `0` falsy and everything else truthy.
///
/// The one answer for the whole engine: `.base` filters, formula conditions, and
/// `tickets --track` all route here, so one `.base` file cannot answer the same
/// question two ways.
///
/// Diverges from Obsidian, which publishes no falsy set. The input is a flattened
/// display string, dropping the Boolean-vs-string distinction Obsidian keeps, so
/// the *strings* `"false"` and `"0"` read falsy here.
pub fn is_truthy(value: &str) -> bool {
    let v = value.trim();
    !(v.is_empty() || v == "false" || v == "0")
}

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
    Asc,
    Desc,
}

#[derive(Debug, Clone)]
pub struct GroupByDef {
    pub property: String,
    pub direction: SortDirection,
}
