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

}
