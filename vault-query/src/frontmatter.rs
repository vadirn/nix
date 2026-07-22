use anyhow::Result;
use serde_yaml::Value;
use std::collections::BTreeMap;

/// The leading frontmatter block of a document, scanned once.
///
/// `frontmatter` is the sole owner of delimiter/BOM scanning: `parse`, `body`,
/// and `body_start_line` all derive from one [`block`] pass rather than
/// re-implementing the open/close `---` scan. A block opens when the first line
/// (BOM-stripped, trimmed) is exactly `---` and closes at the first later line
/// whose trim is `---`.
struct Block<'a> {
    /// BOM-stripped view of the original content. `body` slices against this.
    stripped: &'a str,
    /// Inner YAML text (lines between the delimiters joined with `\n`), present
    /// only when a closing delimiter was found.
    yaml: Option<String>,
    /// Byte offset into `stripped` of the newline terminating the closing
    /// delimiter line (or `stripped.len()` at EOF); `None` when there is no
    /// complete block. `body` returns the slice from here.
    body_offset: Option<usize>,
    /// 1-based line number of the first body line, or 1 when there is no
    /// complete block.
    body_line: usize,
}

/// Index of the next `\n` at or after `from`, or `bytes.len()` if none.
fn next_newline(bytes: &[u8], from: usize) -> usize {
    let mut i = from;
    while i < bytes.len() && bytes[i] != b'\n' {
        i += 1;
    }
    i
}

/// End of a line's content within `[start, nl)`, excluding a trailing `\r` so
/// CRLF and LF endings compare equal.
fn line_content_end(bytes: &[u8], start: usize, nl: usize) -> usize {
    if nl > start && bytes[nl - 1] == b'\r' {
        nl - 1
    } else {
        nl
    }
}

/// Scan the leading frontmatter block once. BOM is stripped up front; the open
/// and close `---` delimiters are matched by trimmed line equality, the same
/// rule `parse` and the former `read` scanners used.
fn block(content: &str) -> Block<'_> {
    let stripped = content.trim_start_matches('\u{feff}');
    let bytes = stripped.as_bytes();

    let none = |stripped| Block {
        stripped,
        yaml: None,
        body_offset: None,
        body_line: 1,
    };

    // Opening delimiter: the first line, trimmed, must be exactly "---".
    let first_nl = next_newline(bytes, 0);
    let first_line = &stripped[0..line_content_end(bytes, 0, first_nl)];
    if first_line.trim() != "---" {
        return none(stripped);
    }
    if first_nl == bytes.len() {
        // Opening "---" with no trailing newline: open, but nothing follows.
        return none(stripped);
    }

    let mut i = first_nl + 1; // start of the second line
    let mut line_no = 1usize; // line 1 is the opening delimiter
    let mut inner: Vec<&str> = Vec::new();

    while i < bytes.len() {
        line_no += 1;
        let line_start = i;
        let nl = next_newline(bytes, line_start);
        let line = &stripped[line_start..line_content_end(bytes, line_start, nl)];
        if line.trim() == "---" {
            // Closing delimiter: body begins at this line's terminating newline.
            return Block {
                stripped,
                yaml: Some(inner.join("\n")),
                body_offset: Some(nl),
                body_line: line_no + 1,
            };
        }
        inner.push(line);
        if nl == bytes.len() {
            break; // last line, no trailing newline, no closing delimiter
        }
        i = nl + 1;
    }

    // No closing delimiter: `parse`/`body`/`body_start_line` see no complete block.
    none(stripped)
}

/// Extract YAML frontmatter from markdown content.
/// Returns None if no frontmatter delimiters found.
pub fn parse(content: &str) -> Result<Option<BTreeMap<String, Value>>> {
    match block(content).yaml {
        Some(yaml) => Ok(Some(serde_yaml::from_str(&yaml)?)),
        None => Ok(None),
    }
}

/// Return the content body after frontmatter (stripping the YAML block).
/// Accepts both LF and CRLF line endings. The returned slice begins at the
/// newline terminating the closing `---`, so it leads with that newline; when
/// there is no complete block the original content is returned unchanged.
pub fn body(content: &str) -> &str {
    let b = block(content);
    match b.body_offset {
        Some(off) => &b.stripped[off..],
        None => content,
    }
}

/// 1-based line number where the body begins (the line after the closing `---`).
/// Returns 1 when there is no complete frontmatter block. A leading BOM is
/// stripped, so a BOM-prefixed `---` still opens the block without shifting the
/// returned line number.
pub fn body_start_line(content: &str) -> usize {
    block(content).body_line
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

/// Return `true` when the file is marked `superseded: true`. Superseded entries
/// are excluded from consult scope by default and may carry an optional
/// `superseded_by: "[[...]]"` wikilink.
pub fn is_superseded(fm: &BTreeMap<String, Value>) -> bool {
    get_bool(fm, "superseded") == Some(true)
}

/// Trust policy lives in [`crate::epistemic`]. Re-exported here so existing
/// `frontmatter::EpistemicTier` / `frontmatter::epistemic_tier` call sites keep
/// compiling after the relocation.
pub use crate::epistemic::{epistemic_tier, EpistemicTier};

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
    fn body_start_line_after_closing_delimiter() {
        // Opening `---` line 1, key line 2, closing `---` line 3 → body line 4.
        assert_eq!(body_start_line("---\nfoo: 1\n---\nbody\n"), 4);
    }

    #[test]
    fn body_start_line_bom_does_not_shift() {
        // A leading BOM does not add a line, so the body still begins at line 4.
        assert_eq!(body_start_line("\u{feff}---\nfoo: 1\n---\nbody\n"), 4);
    }

    #[test]
    fn body_start_line_one_without_block() {
        assert_eq!(body_start_line("# Heading\n\nbody\n"), 1);
        // Open but never closed: whole file is body, line 1.
        assert_eq!(body_start_line("---\nfoo: 1\nno close\n"), 1);
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
}
