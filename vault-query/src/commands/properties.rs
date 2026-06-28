use anyhow::{Context, Result};
use serde_yaml::Value;
use std::fs;
use std::path::Path;

use crate::frontmatter;
use crate::output::{self, Format};

/// Print frontmatter properties (or one addressed field) of `file`. Returns the
/// process exit code (0 on success, 1 when a requested field path misses or the
/// file has no frontmatter) rather than exiting mid-stack, so `main` owns the
/// single exit boundary and the miss branches stay testable.
pub fn run(file: &Path, path: Option<&str>, format: Format) -> Result<i32> {
    let content = fs::read_to_string(file)?;
    let fm = frontmatter::parse(&content)?;

    match path {
        None => {
            let fm = fm.ok_or_else(|| {
                anyhow::anyhow!("no frontmatter found in {}", file.display())
            })?;
            let properties: Vec<(String, String)> = fm
                .iter()
                .map(|(k, v)| (k.clone(), frontmatter::value_to_display(v)))
                .collect();
            println!("{}", output::render_properties(&properties, &format));
            Ok(0)
        }
        Some(p) => {
            let Some(fm) = fm else {
                eprintln!("no frontmatter found in {}", file.display());
                return Ok(1);
            };
            // The frontmatter root is a map; build a Value::Mapping to navigate uniformly.
            let root = Value::Mapping(
                fm.into_iter()
                    .map(|(k, v)| (Value::String(k), v))
                    .collect(),
            );
            match navigate(&root, p) {
                Ok(v) => {
                    print_value(v, format)?;
                    Ok(0)
                }
                Err(msg) => {
                    eprintln!("{}", msg);
                    Ok(1)
                }
            }
        }
    }
}

/// A parsed path segment: a key plus zero or more sequence indices applied in order.
struct Segment {
    key: String,
    indices: Vec<usize>,
}

/// Parse a dotted field path into segments. Each segment is `key` optionally
/// followed by one or more `[digits]` indices, e.g. `references[0].target`.
/// Returns an error message on malformed syntax (empty key, unclosed/empty/non-numeric `[...]`).
fn parse_path(path: &str) -> Result<Vec<Segment>, String> {
    let mut segments = Vec::new();
    for raw in path.split('.') {
        let (key, rest) = match raw.find('[') {
            Some(i) => (&raw[..i], &raw[i..]),
            None => (raw, ""),
        };
        if key.is_empty() {
            return Err(format!("malformed path segment in '{}': empty key", path));
        }
        let indices = parse_indices(rest, path)?;
        segments.push(Segment {
            key: key.to_string(),
            indices,
        });
    }
    if segments.is_empty() {
        return Err(format!("empty path '{}'", path));
    }
    Ok(segments)
}

/// Parse a run of `[digits]` index suffixes from the tail of a segment.
fn parse_indices(mut rest: &str, path: &str) -> Result<Vec<usize>, String> {
    let mut indices = Vec::new();
    while !rest.is_empty() {
        if !rest.starts_with('[') {
            return Err(format!("malformed index in '{}': expected '['", path));
        }
        let close = rest
            .find(']')
            .ok_or_else(|| format!("malformed index in '{}': unclosed '['", path))?;
        let digits = &rest[1..close];
        if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
            return Err(format!("malformed index in '{}': '[{}]' is not a number", path, digits));
        }
        let idx: usize = digits
            .parse()
            .map_err(|_| format!("malformed index in '{}': '[{}]' is not a number", path, digits))?;
        indices.push(idx);
        rest = &rest[close + 1..];
    }
    Ok(indices)
}

/// Navigate a YAML value along a dotted field path, returning the resolved value
/// or a human-readable miss message.
fn navigate<'a>(root: &'a Value, path: &str) -> Result<&'a Value, String> {
    let segments = parse_path(path)?;
    let mut current = root;
    for seg in &segments {
        // Key lookup requires a mapping.
        let map = match current {
            Value::Mapping(m) => m,
            _ => return Err(format!("'{}': cannot read key '{}' on a non-mapping value", path, seg.key)),
        };
        current = map
            .get(Value::String(seg.key.clone()))
            .ok_or_else(|| format!("'{}': key '{}' not found", path, seg.key))?;
        // Apply each trailing index as a sequence access.
        for &idx in &seg.indices {
            let seq = match current {
                Value::Sequence(s) => s,
                _ => return Err(format!("'{}': cannot index '{}[{}]' into a non-sequence value", path, seg.key, idx)),
            };
            current = seq
                .get(idx)
                .ok_or_else(|| format!("'{}': index {} out of range for '{}' (len {})", path, idx, seg.key, seq.len()))?;
        }
    }
    Ok(current)
}

/// Print a resolved value in the requested format. A JSON serialization failure
/// propagates as an error rather than exiting mid-stack.
fn print_value(v: &Value, format: Format) -> Result<()> {
    match format {
        Format::Table | Format::Tsv => {
            println!("{}", frontmatter::value_to_display(v));
        }
        Format::Json => {
            let json: serde_json::Value =
                serde_json::to_value(v).unwrap_or(serde_json::Value::Null);
            let s = serde_json::to_string_pretty(&json)
                .context("failed to serialize value to JSON")?;
            println!("{}", s);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn yaml(s: &str) -> Value {
        serde_yaml::from_str(s).unwrap()
    }

    #[test]
    fn parses_dotted_and_indexed() {
        let segs = parse_path("references[0].target").unwrap();
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].key, "references");
        assert_eq!(segs[0].indices, vec![0]);
        assert_eq!(segs[1].key, "target");
        assert!(segs[1].indices.is_empty());
    }

    #[test]
    fn parses_multiple_indices() {
        let segs = parse_path("a[2][3]").unwrap();
        assert_eq!(segs[0].key, "a");
        assert_eq!(segs[0].indices, vec![2, 3]);
    }

    #[test]
    fn rejects_unclosed_bracket() {
        assert!(parse_path("a[0").is_err());
    }

    #[test]
    fn rejects_empty_index() {
        assert!(parse_path("a[]").is_err());
    }

    #[test]
    fn rejects_non_numeric_index() {
        assert!(parse_path("a[x]").is_err());
    }

    #[test]
    fn rejects_empty_key() {
        assert!(parse_path("a..b").is_err());
    }

    #[test]
    fn navigates_nested_key() {
        let root = yaml("a:\n  b:\n    c: hi\n");
        let v = navigate(&root, "a.b.c").unwrap();
        assert_eq!(v, &Value::String("hi".into()));
    }

    #[test]
    fn navigates_sequence_index() {
        let root = yaml("references:\n  - target: one\n  - target: two\n");
        let v = navigate(&root, "references[1].target").unwrap();
        assert_eq!(v, &Value::String("two".into()));
    }

    #[test]
    fn missing_key_errors() {
        let root = yaml("a: 1\n");
        assert!(navigate(&root, "nope").is_err());
    }

    #[test]
    fn out_of_range_index_errors() {
        let root = yaml("a:\n  - x\n");
        assert!(navigate(&root, "a[5]").is_err());
    }

    #[test]
    fn index_into_non_sequence_errors() {
        let root = yaml("a: 1\n");
        assert!(navigate(&root, "a[0]").is_err());
    }

    #[test]
    fn key_into_non_mapping_errors() {
        let root = yaml("a: 1\n");
        assert!(navigate(&root, "a.b").is_err());
    }
}
