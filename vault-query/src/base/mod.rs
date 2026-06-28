pub mod column;
pub mod date;
pub mod filter;
pub mod formula;
pub mod parse;
pub mod view;

pub use parse::parse;

use std::collections::BTreeMap;

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
