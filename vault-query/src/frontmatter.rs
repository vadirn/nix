use anyhow::Result;
use serde_yaml::Value;
use std::collections::BTreeMap;

/// Extract YAML frontmatter from markdown content.
/// Returns None if no frontmatter delimiters found.
pub fn parse(content: &str) -> Result<Option<BTreeMap<String, Value>>> {
    let content = content.trim_start_matches('\u{feff}'); // strip BOM
    let mut lines = content.lines();

    match lines.next() {
        Some(line) if line.trim() == "---" => {}
        _ => return Ok(None),
    }

    let mut yaml_lines = Vec::new();
    for line in lines {
        if line.trim() == "---" {
            let yaml = yaml_lines.join("\n");
            let map: BTreeMap<String, Value> = serde_yaml::from_str(&yaml)?;
            return Ok(Some(map));
        }
        yaml_lines.push(line);
    }

    Ok(None)
}

/// Return the content body after frontmatter (stripping the YAML block).
/// Accepts both LF and CRLF line endings.
pub fn body(content: &str) -> &str {
    let trimmed = content.trim_start_matches('\u{feff}');
    if !trimmed.starts_with("---") {
        return content;
    }
    let bytes = trimmed.as_bytes();

    // Skip the opening "---" line up to and including its trailing newline.
    let mut i = 3;
    while i < bytes.len() && bytes[i] != b'\n' {
        i += 1;
    }
    if i == bytes.len() {
        return content;
    }
    i += 1;

    // Scan subsequent lines for a closing "---" delimiter, mirroring `parse()`.
    while i < bytes.len() {
        let line_start = i;
        while i < bytes.len() && bytes[i] != b'\n' {
            i += 1;
        }
        let line_end = if i > line_start && bytes[i - 1] == b'\r' {
            i - 1
        } else {
            i
        };
        if trimmed[line_start..line_end].trim() == "---" {
            return if i < bytes.len() { &trimmed[i..] } else { "" };
        }
        if i == bytes.len() {
            break;
        }
        i += 1;
    }
    content
}

/// Get a value from frontmatter by key, returning a display string.
pub fn get_display(fm: &BTreeMap<String, Value>, key: &str) -> String {
    match fm.get(key) {
        Some(v) => value_to_display(v),
        None => String::new(),
    }
}

/// Convert a YAML value to a human-readable display string.
pub fn value_to_display(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        Value::Sequence(seq) => {
            let items: Vec<String> = seq.iter().map(value_to_display).collect();
            items.join(", ")
        }
        Value::Mapping(m) => {
            let items: Vec<String> = m
                .iter()
                .map(|(k, v)| format!("{}: {}", value_to_display(k), value_to_display(v)))
                .collect();
            items.join(", ")
        }
        Value::Tagged(t) => value_to_display(&t.value),
    }
}

/// Get a numeric value from frontmatter.
pub fn get_f64(fm: &BTreeMap<String, Value>, key: &str) -> Option<f64> {
    match fm.get(key)? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.parse::<f64>().ok(),
        _ => None,
    }
}

/// Get a boolean value from frontmatter.
pub fn get_bool(fm: &BTreeMap<String, Value>, key: &str) -> Option<bool> {
    match fm.get(key)? {
        Value::Bool(b) => Some(*b),
        Value::String(s) => match s.as_str() {
            "true" => Some(true),
            "false" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

/// Get the length of a sequence field (0 if missing or not a sequence).
pub fn get_seq_len(fm: &BTreeMap<String, Value>, key: &str) -> usize {
    match fm.get(key) {
        Some(Value::Sequence(seq)) => seq.len(),
        _ => 0,
    }
}

/// Get the string items of a sequence field. Non-string items are skipped;
/// a missing or non-sequence value yields an empty Vec.
pub fn get_string_seq(fm: &BTreeMap<String, Value>, key: &str) -> Vec<String> {
    match fm.get(key) {
        Some(Value::Sequence(items)) => items
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect(),
        _ => Vec::new(),
    }
}

/// Return `true` when the file is marked `template: true`. Templates carry the
/// same `type:` as their instances but are scaffolding, not content, so every
/// content-level scan skips them via this one predicate.
pub fn is_template(fm: &BTreeMap<String, Value>) -> bool {
    get_bool(fm, "template") == Some(true)
}

/// Parse a comma-separated type filter string into a `Vec<String>`.
/// Trims whitespace and drops empty tokens.
/// Provided for callers that receive a raw string (e.g. env-var or config file);
/// clap's `value_delimiter = ','` already produces a split `Vec<String>` directly.
pub fn parse_types(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Return `true` if `doc_type` matches any entry in `allowed`, or if `allowed` is empty.
/// An empty `allowed` slice means "no filter — accept everything".
/// `doc_type` is the value returned by `frontmatter::get_display(&fm, "type")`.
pub fn matches_type(doc_type: &str, allowed: &[String]) -> bool {
    allowed.is_empty() || allowed.iter().any(|t| t == doc_type)
}

/// Check if a string field contains any of the given values.
pub fn contains_any(fm: &BTreeMap<String, Value>, key: &str, values: &[&str]) -> bool {
    match fm.get(key) {
        Some(Value::String(s)) => values.iter().any(|v| s == v),
        Some(Value::Sequence(seq)) => seq.iter().any(|item| {
            if let Value::String(s) = item {
                values.iter().any(|v| s == v)
            } else {
                false
            }
        }),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_frontmatter() {
        let content = "---\ntype: checkpoint\ndone: false\ncost_usd: 1.5\n---\n\n# Body\n";
        let fm = parse(content).unwrap().unwrap();
        assert_eq!(fm.get("type").unwrap(), &Value::String("checkpoint".into()));
        assert_eq!(fm.get("done").unwrap(), &Value::Bool(false));
        assert_eq!(get_f64(&fm, "cost_usd"), Some(1.5));
    }

    #[test]
    fn test_no_frontmatter() {
        let content = "# Just a heading\n\nSome text.";
        assert!(parse(content).unwrap().is_none());
    }

    #[test]
    fn test_sequence_field() {
        let content = "---\ntags:\n  - rust\n  - cli\n---\n";
        let fm = parse(content).unwrap().unwrap();
        assert_eq!(get_seq_len(&fm, "tags"), 2);
        assert_eq!(get_display(&fm, "tags"), "rust, cli");
    }

    #[test]
    fn test_contains_any() {
        let content = "---\nstatus: in progress\n---\n";
        let fm = parse(content).unwrap().unwrap();
        assert!(contains_any(&fm, "status", &["in progress", "planned"]));
        assert!(!contains_any(&fm, "status", &["done"]));
    }

    #[test]
    fn test_body_lf() {
        let content = "---\nfoo: 1\n---\nbody text\n";
        // Original behavior: body slice starts at the newline immediately after closing "---".
        assert_eq!(body(content), "\nbody text\n");
    }

    #[test]
    fn test_body_crlf() {
        let content = "---\r\nfoo: 1\r\n---\r\nbody text\r\n";
        // CRLF must produce an equivalent body slice (newline-prefixed remainder).
        assert_eq!(body(content), "\nbody text\r\n");
    }

    #[test]
    fn test_body_crlf_mixed() {
        // CRLF for frontmatter delimiters, LF inside body — must still find the closing line.
        let content = "---\r\nfoo: 1\r\n---\r\nfirst\nsecond\n";
        assert_eq!(body(content), "\nfirst\nsecond\n");
    }

    #[test]
    fn test_body_no_frontmatter() {
        let content = "# Just a heading\n\nSome text.";
        assert_eq!(body(content), content);
    }

    #[test]
    fn test_body_no_closing_delimiter() {
        let content = "---\nfoo: 1\nbody without close\n";
        assert_eq!(body(content), content);
    }

    #[test]
    fn test_body_dashes_inside_line() {
        // "---bar" is not a closing delimiter even though the original substring search
        // would have falsely matched it.
        let content = "---\nfoo: 1\n---bar\nreal body\n---\nafter\n";
        assert_eq!(body(content), "\nafter\n");
    }

    #[test]
    fn matches_type_empty_allowed_matches_anything() {
        assert!(matches_type("card", &[]), "non-empty type with empty allowed should match");
        assert!(matches_type("", &[]), "empty type with empty allowed should match");
    }

    #[test]
    fn matches_type_non_empty_requires_exact() {
        let allowed = vec!["card".to_string()];
        assert!(matches_type("card", &allowed), "exact match should return true");
        assert!(!matches_type("note", &allowed), "non-matching type should return false");
        assert!(!matches_type("", &allowed), "empty type with non-empty allowed should return false");
    }

    #[test]
    fn parse_types_splits_and_trims() {
        assert_eq!(
            parse_types("card, note ,experiment"),
            vec!["card", "note", "experiment"]
        );
        assert_eq!(parse_types(""), Vec::<String>::new(), "empty input should return empty vec");
        assert_eq!(parse_types(",,"), Vec::<String>::new(), "lone commas should return empty vec");
    }
}
