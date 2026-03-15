use crate::base::view::ViewResult;
use std::str::FromStr;

#[derive(Debug, Clone, PartialEq)]
pub enum Format {
    Table,
    Json,
    Tsv,
}

impl FromStr for Format {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "table" => Ok(Format::Table),
            "json" => Ok(Format::Json),
            "tsv" => Ok(Format::Tsv),
            _ => Err(format!("unknown format: {}", s)),
        }
    }
}

impl std::fmt::Display for Format {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Format::Table => write!(f, "table"),
            Format::Json => write!(f, "json"),
            Format::Tsv => write!(f, "tsv"),
        }
    }
}

pub fn render(result: &ViewResult, format: &Format) -> String {
    match format {
        Format::Table => render_table(result),
        Format::Json => render_json(result),
        Format::Tsv => render_tsv(result),
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
            output.push_str(&row.join("\t"));
            output.push('\n');
        }
    }
    output
}

/// Render a simple key-value list for properties command.
pub fn render_properties(
    properties: &[(String, String)],
    format: &Format,
) -> String {
    match format {
        Format::Table => {
            let mut out = String::from("| Property | Value |\n| --- | --- |\n");
            for (k, v) in properties {
                out.push_str(&format!("| {} | {} |\n", k, v.replace('|', "\\|")));
            }
            out
        }
        Format::Json => {
            let map: serde_json::Map<String, serde_json::Value> = properties
                .iter()
                .map(|(k, v)| (k.clone(), serde_json::Value::String(v.clone())))
                .collect();
            serde_json::to_string_pretty(&serde_json::Value::Object(map)).unwrap_or_default()
        }
        Format::Tsv => {
            let mut output = String::new();
            for (k, v) in properties {
                output.push_str(&format!("{}\t{}\n", k, v));
            }
            output
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::base::view::{Group, ViewResult};

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
}
