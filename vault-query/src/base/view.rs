use crate::base::{BaseFile, SortDirection, ViewDef};
use crate::output::Format;
use crate::vault::VaultFile;
use std::collections::{BTreeMap, HashSet};

/// Result of applying a view to filtered files.
pub struct ViewResult {
    pub headers: Vec<String>,
    pub groups: Vec<Group>,
    pub summaries: Option<Vec<String>>,
}

impl ViewResult {
    /// Render this result in the requested output format.
    pub fn render(&self, format: &Format) -> String {
        match format {
            Format::Table => render_table(self),
            Format::Json => render_json(self),
            Format::Tsv => render_tsv(self),
        }
    }
}

fn render_table(result: &ViewResult) -> String {
    let mut output = String::new();

    for group in &result.groups {
        if let Some(ref label) = group.label {
            if !output.is_empty() {
                output.push('\n');
            }
            output.push_str(&format!("## {}\n\n", label));
        }

        // Markdown table
        let headers = &result.headers;
        output.push_str("| ");
        output.push_str(&headers.join(" | "));
        output.push_str(" |\n");

        output.push('|');
        for _ in headers {
            output.push_str(" --- |");
        }
        output.push('\n');

        for row in &group.rows {
            let cells: Vec<String> = row
                .iter()
                .map(|c| c.replace('|', "\\|").replace('\n', " "))
                .collect();
            output.push_str("| ");
            output.push_str(&cells.join(" | "));
            output.push_str(" |\n");
        }

        if let Some(ref summaries) = result.summaries {
            let cells: Vec<String> = summaries
                .iter()
                .map(|c| if c.is_empty() { String::new() } else { format!("**{}**", c) })
                .collect();
            output.push_str("| ");
            output.push_str(&cells.join(" | "));
            output.push_str(" |\n");
        }

        output.push('\n');
    }

    output
}

fn render_json(result: &ViewResult) -> String {
    let mut records = Vec::new();
    for group in &result.groups {
        for row in &group.rows {
            let mut map = serde_json::Map::new();
            for (i, header) in result.headers.iter().enumerate() {
                let value = row.get(i).cloned().unwrap_or_default();
                map.insert(header.clone(), serde_json::Value::String(value));
            }
            if let Some(ref label) = group.label {
                map.insert("_group".to_string(), serde_json::Value::String(label.clone()));
            }
            records.push(serde_json::Value::Object(map));
        }
    }
    serde_json::to_string_pretty(&records).unwrap_or_default()
}

fn render_tsv(result: &ViewResult) -> String {
    let mut output = String::new();
    output.push_str(&result.headers.join("\t"));
    output.push('\n');
    for group in &result.groups {
        for row in &group.rows {
            // Sanitize tab/newline/CR so a multiline cell can't shift columns,
            // matching render_table's collapse of in-cell newlines.
            let cells: Vec<String> = row.iter().map(|c| c.replace(['\t', '\n', '\r'], " ")).collect();
            output.push_str(&cells.join("\t"));
            output.push('\n');
        }
    }
    output
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
        if let Some(prop) = base.properties.get(key) {
            if !prop.display_name.is_empty() {
                return prop.display_name.clone();
            }
        }
    }
    if col.starts_with("formula.") {
        if let Some(prop) = base.properties.get(col) {
            if !prop.display_name.is_empty() {
                return prop.display_name.clone();
            }
        }
    }
    col.to_string()
}

fn resolve_value(
    col: &str,
    file: &VaultFile,
    formulas: &BTreeMap<String, String>,
) -> String {
    crate::base::column::ColumnRef::parse(col).value(file, formulas)
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
    fn test_render_json() {
        let result = ViewResult {
            headers: vec!["Name".into(), "Status".into()],
            groups: vec![Group {
                label: None,
                rows: vec![vec!["test".into(), "done".into()]],
            }],
            summaries: None,
        };
        let json = render_json(&result);
        assert!(json.contains("\"Name\": \"test\""));
        assert!(json.contains("\"Status\": \"done\""));
    }

    #[test]
    fn test_render_tsv() {
        let result = ViewResult {
            headers: vec!["Name".into(), "Status".into()],
            groups: vec![Group {
                label: None,
                rows: vec![
                    vec!["a".into(), "done".into()],
                    vec!["b".into(), "pending".into()],
                ],
            }],
            summaries: None,
        };
        let tsv = render_tsv(&result);
        assert_eq!(tsv, "Name\tStatus\na\tdone\nb\tpending\n");
    }

    #[test]
    fn test_render_tsv_sanitizes_cell_separators() {
        // A cell containing a tab, newline, or CR must not shift TSV columns;
        // each is collapsed to a space, mirroring render_table's newline handling.
        let result = ViewResult {
            headers: vec!["Name".into(), "Note".into()],
            groups: vec![Group {
                label: None,
                rows: vec![vec!["a".into(), "line1\nline2\tcol\rend".into()]],
            }],
            summaries: None,
        };
        let tsv = render_tsv(&result);
        assert_eq!(tsv, "Name\tNote\na\tline1 line2 col end\n");
    }
}
