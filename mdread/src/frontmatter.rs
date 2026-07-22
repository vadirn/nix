//! Frontmatter surface: the top-level field names in source order (the `fields:`
//! line), the 1-based line at which the body begins, the block's raw text, and
//! addressed lookup along a dotted path.
//!
//! mdstruct reports the frontmatter *block* span but leaves the YAML unparsed
//! (its scope is structure, not field decomposition), so both readings live here.
//! They are deliberately separate: the line scanner ([`block`]) reports what the
//! file says, in source order and with source text, and is what the overview and
//! the whole-block address print; the YAML parse ([`parsed`]) reports what the
//! file *means*, and is what a path like `references[0].target` navigates. A
//! leading BOM is stripped so a BOM-prefixed `---` still opens the block without
//! shifting line numbers.

use serde_yaml::Value;

struct Block<'a> {
    /// Top-level key names between the delimiters, in source order. Empty when
    /// there is no opening delimiter.
    fields: Vec<String>,
    /// 1-based line where the body begins (the line after the closing `---`), or
    /// 1 when there is no complete block.
    body_line: usize,
    /// Inner lines between the delimiters, each with its 1-based line number.
    inner: Vec<(usize, &'a str)>,
    /// True only when both delimiters were found.
    present: bool,
}

/// One top-level frontmatter entry with its raw value text.
#[derive(Debug, Clone, PartialEq)]
pub struct Field {
    pub key: String,
    /// The inline scalar after `:` when present; otherwise the indented
    /// continuation block (list items, nested map), dedented and joined with '\n'.
    pub value: String,
    /// 1-based line of the key.
    pub line: usize,
}

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

/// Top-level key names from the inner block lines, in source order. A key starts
/// in column 0, is non-empty, and precedes a `:`; blank, `#`-comment, and
/// indented (nested) lines are skipped.
fn collect_fields(inner: &[&str]) -> Vec<String> {
    let mut fields = Vec::new();
    for line in inner {
        if line.starts_with(|c: char| c.is_whitespace()) {
            continue;
        }
        let trimmed = line.trim_end();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some(colon) = trimmed.find(':') {
            let key = &trimmed[..colon];
            if !key.is_empty() {
                fields.push(key.to_string());
            }
        }
    }
    fields
}

/// Scan the leading frontmatter block once. BOM is stripped up front; the open
/// and close `---` delimiters are matched by trimmed line equality.
fn block(content: &str) -> Block<'_> {
    let stripped = content.trim_start_matches('\u{feff}');
    let bytes = stripped.as_bytes();

    let none = || Block {
        fields: Vec::new(),
        body_line: 1,
        inner: Vec::new(),
        present: false,
    };

    // Opening delimiter: the first line, trimmed, must be exactly "---".
    let first_nl = next_newline(bytes, 0);
    let first_line = &stripped[0..line_content_end(bytes, 0, first_nl)];
    if first_line.trim() != "---" {
        return none();
    }
    if first_nl == bytes.len() {
        return none();
    }

    let mut i = first_nl + 1; // start of the second line
    let mut line_no = 1usize; // line 1 is the opening delimiter
    let mut inner: Vec<(usize, &str)> = Vec::new();

    while i < bytes.len() {
        line_no += 1;
        let line_start = i;
        let nl = next_newline(bytes, line_start);
        let line = &stripped[line_start..line_content_end(bytes, line_start, nl)];
        if line.trim() == "---" {
            let texts: Vec<&str> = inner.iter().map(|(_, t)| *t).collect();
            return Block {
                fields: collect_fields(&texts),
                body_line: line_no + 1,
                inner,
                present: true,
            };
        }
        inner.push((line_no, line));
        if nl == bytes.len() {
            break; // last line, no trailing newline, no closing delimiter
        }
        i = nl + 1;
    }

    // No closing delimiter: report the keys scanned, but the body sees no block.
    let texts: Vec<&str> = inner.iter().map(|(_, t)| *t).collect();
    Block {
        fields: collect_fields(&texts),
        body_line: 1,
        inner,
        present: false,
    }
}

/// Top-level frontmatter key names in on-disk source order (the overview's
/// `fields:` line). Empty when there is no frontmatter block.
pub fn field_order(content: &str) -> Vec<String> {
    block(content).fields
}

/// 1-based line number where the body begins (the line after the closing `---`),
/// or 1 when there is no complete frontmatter block.
pub fn body_start_line(content: &str) -> usize {
    block(content).body_line
}

/// Raw inner YAML of the frontmatter block (delimiters excluded), or `None` when
/// the file has no complete block.
pub fn block_text(content: &str) -> Option<String> {
    let b = block(content);
    if !b.present {
        return None;
    }
    Some(
        b.inner
            .iter()
            .map(|(_, t)| *t)
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

/// Inclusive 1-based line range of the block's inner content, or `None` when the
/// file has no complete block or the block is empty.
pub fn block_line_range(content: &str) -> Option<(usize, usize)> {
    let b = block(content);
    if !b.present || b.inner.is_empty() {
        return None;
    }
    Some((b.inner[0].0, b.inner[b.inner.len() - 1].0))
}

/// Every top-level entry with its raw value text, in source order.
///
/// A key owns the indented lines that follow it (list items, nested maps), so
/// `tags:\n  - a\n  - b` yields value `"- a\n- b"` — dedented, never re-parsed.
pub fn fields_with_values(content: &str) -> Vec<Field> {
    let b = block(content);
    let mut out: Vec<Field> = Vec::new();
    let mut pending: Vec<&str> = Vec::new();

    // Close the open field by attaching its collected continuation lines.
    fn flush(out: &mut [Field], pending: &mut Vec<&str>) {
        if let Some(last) = out.last_mut()
            && last.value.is_empty()
        {
            last.value = dedent(pending);
        }
        pending.clear();
    }

    for (line_no, text) in &b.inner {
        let indented = text.starts_with(|c: char| c.is_whitespace());
        let trimmed = text.trim_end();

        if indented || trimmed.trim().is_empty() {
            // Continuation (or blank) line: belongs to the open field.
            if !trimmed.trim().is_empty() {
                pending.push(trimmed);
            }
            continue;
        }
        if trimmed.starts_with('#') {
            continue; // column-0 comment: not a key, not continuation
        }
        let Some(colon) = trimmed.find(':') else {
            continue;
        };
        let key = &trimmed[..colon];
        if key.is_empty() {
            continue;
        }
        flush(&mut out, &mut pending);
        out.push(Field {
            key: key.to_string(),
            value: trimmed[colon + 1..].trim().to_string(),
            line: *line_no,
        });
    }
    flush(&mut out, &mut pending);
    out
}

/// The frontmatter block parsed as YAML: `None` when the file has no complete
/// block, `Some(Err)` when the block is not valid YAML.
pub fn parsed(content: &str) -> Option<Result<Value, String>> {
    let text = block_text(content)?;
    Some(serde_yaml::from_str(&text).map_err(|e| format!("frontmatter is not valid YAML: {}", e)))
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
            return Err(format!(
                "malformed index in '{}': '[{}]' is not a number",
                path, digits
            ));
        }
        let idx: usize = digits.parse().map_err(|_| {
            format!("malformed index in '{}': '[{}]' is not a number", path, digits)
        })?;
        indices.push(idx);
        rest = &rest[close + 1..];
    }
    Ok(indices)
}

/// Navigate a YAML value along a dotted field path, returning the resolved value
/// or a human-readable miss message.
pub fn value_at<'a>(root: &'a Value, path: &str) -> Result<&'a Value, String> {
    let segments = parse_path(path)?;
    let mut current = root;
    for seg in &segments {
        // Key lookup requires a mapping.
        let map = match current {
            Value::Mapping(m) => m,
            _ => {
                return Err(format!(
                    "'{}': cannot read key '{}' on a non-mapping value",
                    path, seg.key
                ));
            }
        };
        current = map
            .get(Value::String(seg.key.clone()))
            .ok_or_else(|| format!("'{}': key '{}' not found", path, seg.key))?;
        // Apply each trailing index as a sequence access.
        for &idx in &seg.indices {
            let seq = match current {
                Value::Sequence(s) => s,
                _ => {
                    return Err(format!(
                        "'{}': cannot index '{}[{}]' into a non-sequence value",
                        path, seg.key, idx
                    ));
                }
            };
            current = seq.get(idx).ok_or_else(|| {
                format!(
                    "'{}': index {} out of range for '{}' (len {})",
                    path,
                    idx,
                    seg.key,
                    seq.len()
                )
            })?;
        }
    }
    Ok(current)
}

/// Render a resolved value for text output. A scalar prints bare; a sequence or
/// mapping prints as YAML, so a compound value round-trips instead of flattening
/// to one comma-joined line.
pub fn value_to_text(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        Value::Tagged(t) => value_to_text(&t.value),
        Value::Sequence(_) | Value::Mapping(_) => serde_yaml::to_string(v)
            .unwrap_or_default()
            .trim_end()
            .to_string(),
    }
}

/// Strip the common leading indentation from a set of lines and join with '\n'.
fn dedent(lines: &[&str]) -> String {
    let min = lines
        .iter()
        .map(|l| l.len() - l.trim_start().len())
        .min()
        .unwrap_or(0);
    lines
        .iter()
        .map(|l| &l[min.min(l.len())..])
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_frontmatter_body_starts_at_one() {
        assert!(field_order("just body\n").is_empty());
        assert_eq!(body_start_line("just body\n"), 1);
    }

    #[test]
    fn fields_in_source_order() {
        let c = "---\ntype: note\nslug: x\ndescription: d\n---\n\nbody\n";
        assert_eq!(field_order(c), vec!["type", "slug", "description"]);
        // Body begins on the line after the closing delimiter (line 6).
        assert_eq!(body_start_line(c), 6);
    }

    #[test]
    fn nested_and_comment_lines_skipped() {
        let c = "---\ntags:\n  - a\n  - b\n# comment\nname: x\n---\nbody\n";
        assert_eq!(field_order(c), vec!["tags", "name"]);
    }

    #[test]
    fn field_order_follows_source_not_alphabetical() {
        // Source order (type, created, aliases) differs from alphabetical.
        let c = "---\ntype: note\ncreated: 2026-01-01\naliases:\n  - alt\n---\n\nbody\n";
        assert_eq!(field_order(c), vec!["type", "created", "aliases"]);
    }

    #[test]
    fn field_order_collects_through_missing_close() {
        // Without a closing delimiter there is no complete block, yet the field
        // scan still reports the top-level keys it saw, and the body starts at 1.
        assert_eq!(field_order("---\nfoo: 1\nbar: 2\n"), vec!["foo", "bar"]);
        assert_eq!(body_start_line("---\nfoo: 1\nbar: 2\n"), 1);
    }

    #[test]
    fn bom_prefixed_frontmatter_is_skipped() {
        let body = "---\ntype: note\n---\n\nbody\n";
        let bommed = format!("\u{feff}{}", body);
        assert_eq!(field_order(&bommed), vec!["type".to_string()]);
        assert_eq!(body_start_line(&bommed), body_start_line(body));
    }

    // --- block text / values ---

    #[test]
    fn block_text_is_inner_yaml_without_delimiters() {
        let c = "---\ntype: note\nslug: x\n---\n\nbody\n";
        assert_eq!(block_text(c).unwrap(), "type: note\nslug: x");
        assert_eq!(block_line_range(c), Some((2, 3)));
    }

    #[test]
    fn no_complete_block_has_no_text() {
        assert!(block_text("just body\n").is_none());
        assert!(block_line_range("just body\n").is_none());
        // Unclosed block is not a complete block.
        assert!(block_text("---\nfoo: 1\n").is_none());
    }

    #[test]
    fn values_capture_inline_scalars() {
        let c = "---\ntype: note\ncreated: 2026-01-01\n---\nbody\n";
        let fs = fields_with_values(c);
        assert_eq!(fs.len(), 2);
        assert_eq!(fs[0], Field { key: "type".into(), value: "note".into(), line: 2 });
        assert_eq!(fs[1].key, "created");
        assert_eq!(fs[1].value, "2026-01-01");
    }

    #[test]
    fn values_capture_nested_block_dedented() {
        let c = "---\ntags:\n  - a\n  - b\nname: x\n---\nbody\n";
        let fs = fields_with_values(c);
        assert_eq!(fs.len(), 2);
        assert_eq!(fs[0].key, "tags");
        // Indented continuation is dedented, never re-parsed.
        assert_eq!(fs[0].value, "- a\n- b");
        assert_eq!(fs[1].key, "name");
        assert_eq!(fs[1].value, "x");
    }

    #[test]
    fn values_agree_with_field_order() {
        let c = "---\ntype: note\ntags:\n  - a\n# comment\nname: x\n---\nbody\n";
        let keys: Vec<String> = fields_with_values(c).into_iter().map(|f| f.key).collect();
        assert_eq!(keys, field_order(c));
    }

    // --- addressed lookup ---

    const NESTED: &str = "---\ntype: card\nreferences:\n  - target: one\n    kind: book\n  - target: two\nmeta:\n  depth:\n    n: 3\n---\n\nbody\n";

    fn root(content: &str) -> Value {
        parsed(content).expect("has a block").expect("valid YAML")
    }

    #[test]
    fn parsed_reports_absence_and_invalidity_apart() {
        // No block at all versus a block that is not YAML: distinct outcomes, so
        // a malformed block never reads as a missing one.
        assert!(parsed("just body\n").is_none());
        assert!(parsed("---\ntype: note\n---\n").unwrap().is_ok());
        assert!(parsed("---\na: [unclosed\n---\n").unwrap().is_err());
    }

    #[test]
    fn navigates_nested_keys_and_indices() {
        let r = root(NESTED);
        assert_eq!(value_at(&r, "type").unwrap(), &Value::String("card".into()));
        assert_eq!(
            value_at(&r, "references[1].target").unwrap(),
            &Value::String("two".into())
        );
        assert_eq!(value_to_text(value_at(&r, "meta.depth.n").unwrap()), "3");
    }

    #[test]
    fn path_misses_name_what_failed() {
        let r = root(NESTED);
        for (path, needle) in [
            ("nope", "not found"),
            ("references[9]", "out of range"),
            ("type[0]", "non-sequence"),
            ("type.sub", "non-mapping"),
            ("a[0", "unclosed"),
            ("a[]", "not a number"),
            ("a[x]", "not a number"),
            ("a..b", "empty key"),
        ] {
            let err = value_at(&r, path).unwrap_err();
            assert!(err.contains(needle), "path {path}: got {err}");
        }
    }

    #[test]
    fn compound_values_render_as_yaml_scalars_render_bare() {
        let r = root(NESTED);
        // A scalar prints as itself, with no YAML quoting or trailing newline.
        assert_eq!(value_to_text(value_at(&r, "type").unwrap()), "card");
        // A sequence keeps its shape rather than collapsing to "one, two".
        let seq = value_to_text(value_at(&r, "references").unwrap());
        assert!(seq.starts_with("- target: one"), "got: {seq}");
        assert!(seq.contains("- target: two"), "got: {seq}");
        assert!(!seq.ends_with('\n'), "no trailing newline: {seq:?}");
    }
}
