//! Column references in a `.base` view.
//!
//! A `.base` column addresses a value through one of four namespaces: the
//! built-in `file.*` accessors (`file.name`, `file.ctime`), a computed
//! `formula.<name>`, an explicit `note.<field>` frontmatter lookup, or a bare
//! field name resolved against frontmatter. [`ColumnRef`] classifies a column
//! string once and resolves its value, replacing the prefix matching that was
//! inlined in `view`'s value/sort/group paths.

use crate::base::date;
use crate::frontmatter;
use crate::vault::VaultFile;
use std::collections::BTreeMap;

/// A column reference classified by its namespace prefix.
#[derive(Debug, Clone, PartialEq)]
pub enum ColumnRef<'a> {
    /// `file.name`
    FileName,
    /// `file.ctime`
    FileCtime,
    /// `formula.<name>` — looked up in the per-file formula results.
    Formula(&'a str),
    /// `note.<field>` — an explicit frontmatter field.
    Note(&'a str),
    /// A bare name resolved against frontmatter.
    Bare(&'a str),
}

impl<'a> ColumnRef<'a> {
    /// Classify a column string by its namespace prefix.
    pub fn parse(col: &'a str) -> Self {
        match col {
            "file.name" => Self::FileName,
            "file.ctime" => Self::FileCtime,
            _ => {
                if let Some(name) = col.strip_prefix("formula.") {
                    Self::Formula(name)
                } else if let Some(field) = col.strip_prefix("note.") {
                    Self::Note(field)
                } else {
                    Self::Bare(col)
                }
            }
        }
    }

    /// Resolve this column to its display string for `file`, using the
    /// already-computed `formulas` for `formula.*` columns.
    pub fn value(&self, file: &VaultFile, formulas: &BTreeMap<String, String>) -> String {
        match self {
            Self::FileName => file.name.clone(),
            Self::FileCtime => {
                if let Some(Ok(duration)) =
                    file.ctime.map(|c| c.duration_since(std::time::UNIX_EPOCH))
                {
                    date::format_timestamp(duration.as_secs())
                } else {
                    String::new()
                }
            }
            Self::Formula(name) => formulas.get(*name).cloned().unwrap_or_default(),
            Self::Note(field) | Self::Bare(field) => {
                crate::wikilink::strip(&frontmatter::get_display(&file.frontmatter, field))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_yaml::Value;
    use std::path::PathBuf;
    use std::time::{Duration, UNIX_EPOCH};

    fn make_file(name: &str, props: Vec<(&str, Value)>) -> VaultFile {
        let mut fm = BTreeMap::new();
        for (k, v) in props {
            fm.insert(k.to_string(), v);
        }
        VaultFile {
            path: PathBuf::from(format!("/vault/{}.md", name)),
            name: name.to_string(),
            frontmatter: fm,
            ..Default::default()
        }
    }

    #[test]
    fn parse_classifies_each_namespace() {
        assert_eq!(ColumnRef::parse("file.name"), ColumnRef::FileName);
        assert_eq!(ColumnRef::parse("file.ctime"), ColumnRef::FileCtime);
        assert_eq!(ColumnRef::parse("formula.cost"), ColumnRef::Formula("cost"));
        assert_eq!(ColumnRef::parse("note.status"), ColumnRef::Note("status"));
        assert_eq!(ColumnRef::parse("status"), ColumnRef::Bare("status"));
        // A bare name that merely contains a dot is not a known prefix.
        assert_eq!(ColumnRef::parse("file.other"), ColumnRef::Bare("file.other"));
    }

    #[test]
    fn value_resolves_file_name() {
        let f = make_file("cp1", vec![]);
        let formulas = BTreeMap::new();
        assert_eq!(ColumnRef::parse("file.name").value(&f, &formulas), "cp1");
    }

    #[test]
    fn value_resolves_formula_and_missing_formula() {
        let f = make_file("cp1", vec![]);
        let mut formulas = BTreeMap::new();
        formulas.insert("cost".to_string(), "0.025".to_string());
        assert_eq!(ColumnRef::parse("formula.cost").value(&f, &formulas), "0.025");
        // Unknown formula resolves to empty rather than panicking.
        assert_eq!(ColumnRef::parse("formula.missing").value(&f, &formulas), "");
    }

    #[test]
    fn value_resolves_note_and_bare_identically() {
        let f = make_file("cp1", vec![("status", Value::String("done".into()))]);
        let formulas = BTreeMap::new();
        assert_eq!(ColumnRef::parse("note.status").value(&f, &formulas), "done");
        assert_eq!(ColumnRef::parse("status").value(&f, &formulas), "done");
    }

    #[test]
    fn value_formats_file_ctime() {
        let mut f = make_file("cp1", vec![]);
        // 2024-01-01 00:00 UTC = 1704067200
        f.ctime = Some(UNIX_EPOCH + Duration::from_secs(1704067200));
        let formulas = BTreeMap::new();
        assert_eq!(
            ColumnRef::parse("file.ctime").value(&f, &formulas),
            "2024-01-01 00:00"
        );
    }

    #[test]
    fn value_ctime_empty_when_absent() {
        let f = make_file("cp1", vec![]);
        let formulas = BTreeMap::new();
        assert_eq!(ColumnRef::parse("file.ctime").value(&f, &formulas), "");
    }
}
