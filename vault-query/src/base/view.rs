use crate::base::{BaseFile, SortDirection, ViewDef};
use crate::frontmatter;
use crate::vault::VaultFile;
use std::collections::{BTreeMap, HashSet};

/// Result of applying a view to filtered files.
pub struct ViewResult {
    pub headers: Vec<String>,
    pub groups: Vec<Group>,
    pub summaries: Option<Vec<String>>,
}

pub struct Group {
    pub label: Option<String>,
    pub rows: Vec<Vec<String>>,
}

/// Apply a view to filtered files, producing renderable rows.
pub fn apply(
    view: &ViewDef,
    base: &BaseFile,
    files: &mut Vec<VaultFile>,
) -> ViewResult {
    // Compute formulas for each file, then sort files and formulas together
    let mut formula_results: Vec<BTreeMap<String, String>> = files
        .iter()
        .map(|f| crate::base::formula::evaluate_all(&base.formulas, f))
        .collect();

    sort_files(files, &mut formula_results, &view.sort);

    // Build headers from property display names
    let headers: Vec<String> = view
        .order
        .iter()
        .map(|col| resolve_display_name(col, base))
        .collect();

    // Build rows
    let rows: Vec<Vec<String>> = files
        .iter()
        .zip(formula_results.iter())
        .map(|(file, formulas)| {
            view.order
                .iter()
                .map(|col| resolve_value(col, file, formulas))
                .collect()
        })
        .collect();

    // Group if needed
    let groups = if let Some(ref gb) = view.group_by {
        let group_values: Vec<String> = files
            .iter()
            .zip(formula_results.iter())
            .map(|(file, formulas)| resolve_value(&gb.property, file, formulas))
            .collect();

        build_groups(&group_values, &rows, &gb.direction)
    } else {
        vec![Group { label: None, rows }]
    };

    // Summaries
    let summaries = if !view.summaries.is_empty() {
        Some(compute_summaries(
            &view.summaries,
            &view.order,
            files,
            &formula_results,
        ))
    } else {
        None
    };

    ViewResult {
        headers,
        groups,
        summaries,
    }
}

fn resolve_display_name(col: &str, base: &BaseFile) -> String {
    // Try note.X, then file.X, then formula.X, then raw col name
    let candidates = [
        format!("note.{}", col),
        format!("file.{}", col),
        col.to_string(),
    ];
    for key in &candidates {
        if let Some(prop) = base.properties.get(key)
            && !prop.display_name.is_empty()
        {
            return prop.display_name.clone();
        }
    }
    // Check if col itself starts with "formula."
    if col.starts_with("formula.")
        && let Some(prop) = base.properties.get(col)
        && !prop.display_name.is_empty()
    {
        return prop.display_name.clone();
    }
    col.to_string()
}

fn resolve_value(
    col: &str,
    file: &VaultFile,
    formulas: &BTreeMap<String, String>,
) -> String {
    // file.name
    if col == "file.name" {
        return file.name.clone();
    }
    // file.ctime
    if col == "file.ctime" {
        if let Some(ctime) = file.ctime
            && let Ok(duration) = ctime.duration_since(std::time::UNIX_EPOCH)
        {
            let secs = duration.as_secs();
            return chrono_format(secs);
        }
        return String::new();
    }
    // formula.X
    if let Some(fname) = col.strip_prefix("formula.") {
        return formulas.get(fname).cloned().unwrap_or_default();
    }
    // note.X (strip prefix for lookup)
    if let Some(field) = col.strip_prefix("note.") {
        return crate::wikilink::strip(&frontmatter::get_display(&file.frontmatter, field));
    }
    // Bare field name: try frontmatter
    crate::wikilink::strip(&frontmatter::get_display(&file.frontmatter, col))
}

/// Simple timestamp to ISO date string (no chrono dependency).
fn chrono_format(secs: u64) -> String {
    // Unix timestamp to YYYY-MM-DD HH:MM
    let days = secs / 86400;
    let time_secs = secs % 86400;
    let hours = time_secs / 3600;
    let minutes = (time_secs % 3600) / 60;

    // Days since 1970-01-01
    let mut y = 1970i64;
    let mut remaining_days = days as i64;
    loop {
        let days_in_year = if is_leap(y) { 366 } else { 365 };
        if remaining_days < days_in_year {
            break;
        }
        remaining_days -= days_in_year;
        y += 1;
    }
    let months = [31, if is_leap(y) { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut m = 0;
    for &days_in_month in &months {
        if remaining_days < days_in_month {
            break;
        }
        remaining_days -= days_in_month;
        m += 1;
    }
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}",
        y,
        m + 1,
        remaining_days + 1,
        hours,
        minutes
    )
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn sort_files(
    files: &mut Vec<VaultFile>,
    formula_results: &mut Vec<BTreeMap<String, String>>,
    sort_defs: &[super::SortDef],
) {
    if sort_defs.is_empty() {
        return;
    }

    // Precompute sort keys to avoid recomputing in comparator
    let keys: Vec<Vec<String>> = files
        .iter()
        .zip(formula_results.iter())
        .map(|(file, formulas)| {
            sort_defs
                .iter()
                .map(|sd| resolve_value(&sd.property, file, formulas))
                .collect()
        })
        .collect();

    // Build index permutation
    let mut indices: Vec<usize> = (0..files.len()).collect();
    indices.sort_by(|&a, &b| {
        for (i, sd) in sort_defs.iter().enumerate() {
            let ord = keys[a][i].cmp(&keys[b][i]);
            let ord = match sd.direction {
                SortDirection::Asc => ord,
                SortDirection::Desc => ord.reverse(),
            };
            if ord != std::cmp::Ordering::Equal {
                return ord;
            }
        }
        std::cmp::Ordering::Equal
    });

    // Apply permutation: zip into pairs, reorder, unzip
    let mut pairs: Vec<(VaultFile, BTreeMap<String, String>)> = files
        .drain(..)
        .zip(formula_results.drain(..))
        .collect();
    let reordered: Vec<(VaultFile, BTreeMap<String, String>)> = indices
        .iter()
        .map(|&i| std::mem::take(&mut pairs[i]))
        .collect();
    let (f, r): (Vec<_>, Vec<_>) = reordered.into_iter().unzip();
    *files = f;
    *formula_results = r;
}

fn build_groups(
    group_values: &[String],
    rows: &[Vec<String>],
    direction: &SortDirection,
) -> Vec<Group> {
    let mut seen_set = HashSet::new();
    let mut seen = Vec::new();
    let mut groups_map: BTreeMap<String, Vec<Vec<String>>> = BTreeMap::new();

    for (i, label) in group_values.iter().enumerate() {
        if seen_set.insert(label.clone()) {
            seen.push(label.clone());
        }
        groups_map.entry(label.clone()).or_default().push(rows[i].clone());
    }

    // Sort groups
    match direction {
        SortDirection::Asc => seen.sort(),
        SortDirection::Desc => {
            seen.sort();
            seen.reverse();
        }
    }

    seen.into_iter()
        .map(|label| Group {
            rows: groups_map.remove(&label).unwrap_or_default(),
            label: Some(label),
        })
        .collect()
}

fn compute_summaries(
    summary_defs: &BTreeMap<String, String>,
    order: &[String],
    files: &[VaultFile],
    formula_results: &[BTreeMap<String, String>],
) -> Vec<String> {
    order
        .iter()
        .map(|col| {
            let summary_op = summary_defs.get(col)
                .or_else(|| summary_defs.get(&format!("note.{}", col)))
                .or_else(|| summary_defs.get(&format!("formula.{}", col)));

            match summary_op {
                Some(op) => {
                    let values: Vec<f64> = files
                        .iter()
                        .zip(formula_results.iter())
                        .filter_map(|(file, formulas)| {
                            let val = resolve_value(col, file, formulas);
                            val.parse::<f64>().ok()
                        })
                        .collect();

                    match op.as_str() {
                        "Sum" => {
                            let sum: f64 = values.iter().sum();
                            crate::base::formula::format_number(sum)
                        }
                        "Average" => {
                            if values.is_empty() {
                                String::new()
                            } else {
                                let avg = values.iter().sum::<f64>() / values.len() as f64;
                                format!("{:.3}", avg)
                            }
                        }
                        _ => String::new(),
                    }
                }
                None => String::new(),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_chrono_format() {
        // 2024-01-01 00:00 UTC = 1704067200
        let s = chrono_format(1704067200);
        assert_eq!(s, "2024-01-01 00:00");
    }
}
