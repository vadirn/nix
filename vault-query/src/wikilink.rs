use pulldown_cmark::{Event, Parser, Tag, TagEnd};
use regex::Regex;
use std::collections::HashMap;
use std::sync::LazyLock;
use unicode_normalization::UnicodeNormalization;

static WIKILINK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[\[([^\]|]+)(?:\|([^\]]*))?\]\]").unwrap());

/// A parsed wikilink.
#[derive(Debug, Clone, PartialEq)]
pub struct Wikilink {
    pub target: String, // the link target (path or name)
    pub alias: Option<String>, // display alias if present
    pub line: u32, // 1-based line number where the link appears
}

/// Extract all wikilinks from content.
///
/// Uses pulldown-cmark to walk Markdown events, so wikilinks inside fenced
/// code blocks and inline code spans are suppressed.  YAML frontmatter is
/// stripped first via `frontmatter::body`.
///
/// Pulldown-cmark fragments `[[target]]` into multiple consecutive `Event::Text`
/// events (`[`, `[`, `target`, `]`, `]`) because `[[...]]` is not standard
/// Markdown link syntax.  The strategy is to collect contiguous non-code text
/// byte ranges from the parsed body, then run the regex against `&body[range]`
/// so the full wikilink is visible in one pass.
pub fn extract(content: &str) -> Vec<Wikilink> {
    let body = crate::frontmatter::body(content);

    // Byte offset of body within content (body is a substring of content).
    let body_byte_start = body.as_ptr() as usize - content.as_ptr() as usize;

    // Precompute newline byte positions in the FULL content for O(log n) line lookup.
    // Because absolute_offset is relative to the start of content (not body), the
    // partition_point result already accounts for frontmatter lines.
    let newlines: Vec<usize> = content
        .bytes()
        .enumerate()
        .filter_map(|(i, b)| if b == b'\n' { Some(i) } else { None })
        .collect();

    // Collect contiguous non-code text spans as byte ranges into `body`.
    // Adjacent text events are merged so that `[[target]]` — which cmark splits
    // into '[', '[', 'target', ']', ']' — appears whole when we run the regex.
    let text_spans = collect_text_spans(body);

    let mut result = Vec::new();

    for span in text_spans {
        let text = &body[span.clone()];
        for cap in WIKILINK_RE.captures_iter(text) {
            let match_start = cap.get(0).unwrap().start();
            // Body-relative byte offset of the match start.
            let body_relative_offset = span.start + match_start;
            // Absolute byte offset within content.
            let absolute_offset = body_byte_start + body_relative_offset;
            // 1-based line number via binary search over newline positions in
            // the full content. All frontmatter newlines are already counted.
            let line =
                newlines.partition_point(|&n| n < absolute_offset) as u32 + 1;
            result.push(Wikilink {
                target: cap[1].to_string(),
                alias: cap.get(2).map(|m| m.as_str().to_string()),
                line,
            });
        }
    }

    result
}

/// Walk pulldown-cmark events for `body` and return a list of byte ranges that
/// correspond to non-code text.  Adjacent `Event::Text` ranges are merged so
/// that wikilinks split across multiple text events appear as a single span.
fn collect_text_spans(body: &str) -> Vec<std::ops::Range<usize>> {
    let mut spans: Vec<std::ops::Range<usize>> = Vec::new();
    let mut in_code_depth: u32 = 0;
    // The range of the currently-open merged text span (None if no span open).
    let mut current: Option<std::ops::Range<usize>> = None;

    for (event, range) in Parser::new(body).into_offset_iter() {
        match event {
            Event::Start(Tag::CodeBlock(_)) => {
                if let Some(span) = current.take() {
                    spans.push(span);
                }
                in_code_depth += 1;
            }
            Event::End(TagEnd::CodeBlock) => {
                in_code_depth = in_code_depth.saturating_sub(1);
            }
            Event::Text(_) if in_code_depth == 0 => {
                // Merge this text event into the current open span if contiguous.
                match current {
                    Some(ref mut open) if open.end == range.start => {
                        open.end = range.end;
                    }
                    _ => {
                        if let Some(span) = current.take() {
                            spans.push(span);
                        }
                        current = Some(range);
                    }
                }
            }
            _ if in_code_depth == 0 => {
                // Any non-text event (SoftBreak, HardBreak, Start/End tags, Code, …)
                // breaks the continuity of the text span.
                if let Some(span) = current.take() {
                    spans.push(span);
                }
            }
            _ => {}
        }
    }
    if let Some(span) = current.take() {
        spans.push(span);
    }
    spans
}

/// Resolve a wikilink target to a note name (last path component, no extension).
///
/// Steps:
/// 1. Strip any `#anchor` suffix (covers both `#Heading` and `#^block-ref`).
/// 2. Take the last `/`-separated segment (strip folder prefix).
/// 3. Strip a trailing `.md` extension if present; leave all other dots intact.
pub fn resolve_name(target: &str) -> &str {
    let without_anchor = target.split('#').next().unwrap_or(target);
    let last_segment = without_anchor.rsplit('/').next().unwrap_or(without_anchor);
    last_segment.strip_suffix(".md").unwrap_or(last_segment)
}

/// NFKC-normalize `s` and fold typographic quotes to ASCII equivalents.
///
/// Applies NFKC decomposition (which collapses U+00A0 NO-BREAK SPACE to U+0020,
/// ligatures, compatibility forms, etc.), then maps U+2018/2019 (curly single
/// quotes) to `'` and U+201C/201D (curly double quotes) to `"`, then lowercases.
/// Used by lint rules that compare wikilink targets against on-disk filenames.
pub(crate) fn normalize(s: &str) -> String {
    s.nfkc()
        .map(|c| match c {
            '\u{2018}' | '\u{2019}' => '\'',
            '\u{201C}' | '\u{201D}' => '"',
            _ => c,
        })
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// Strip wikilink syntax from a string, keeping display text.
pub fn strip(text: &str) -> String {
    WIKILINK_RE
        .replace_all(text, |caps: &regex::Captures| {
            caps.get(2)
                .map(|m| m.as_str().to_string())
                .unwrap_or_else(|| {
                    let target = &caps[1];
                    resolve_name(target).to_string()
                })
        })
        .to_string()
}

/// Build an index mapping note names to their incoming links.
/// Key: note name (lowercase), Value: list of source file names that link to it.
pub fn build_backlink_index(
    files: &[crate::vault::VaultFile],
) -> HashMap<String, Vec<String>> {
    let mut index: HashMap<String, Vec<String>> = HashMap::new();
    for file in files {
        // Collect wikilinks from the Markdown body.
        let links = extract(&file.content);
        for link in links {
            let target_name = resolve_name(&link.target).to_lowercase();
            index
                .entry(target_name)
                .or_default()
                .push(file.name.clone());
        }
        // Collect wikilinks from every YAML frontmatter scalar value.
        for value in file.frontmatter.values() {
            collect_frontmatter_wikilinks(value, &file.name, &mut index);
        }
    }
    index
}

/// Collect all unique wikilink targets for a file: union of body wikilinks
/// (via `extract`) and frontmatter wikilinks (recursively scanning YAML values).
/// Source order is preserved; duplicates are removed (first occurrence kept).
pub fn collect_all_link_targets(file: &crate::vault::VaultFile) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut result = Vec::new();

    // Body wikilinks
    for link in extract(&file.content) {
        if seen.insert(link.target.clone()) {
            result.push(link.target);
        }
    }

    // Frontmatter wikilinks
    for value in file.frontmatter.values() {
        collect_frontmatter_link_targets(value, &mut seen, &mut result);
    }

    result
}

/// Recursively walk a `serde_yaml::Value` and collect wikilink targets into `out`.
fn collect_frontmatter_link_targets(
    value: &serde_yaml::Value,
    seen: &mut std::collections::HashSet<String>,
    out: &mut Vec<String>,
) {
    match value {
        serde_yaml::Value::String(s) => {
            for link in extract(s) {
                if seen.insert(link.target.clone()) {
                    out.push(link.target);
                }
            }
        }
        serde_yaml::Value::Sequence(items) => {
            for item in items {
                collect_frontmatter_link_targets(item, seen, out);
            }
        }
        serde_yaml::Value::Mapping(map) => {
            for (_key, val) in map {
                collect_frontmatter_link_targets(val, seen, out);
            }
        }
        _ => {}
    }
}

/// Recursively walk a `serde_yaml::Value` and merge any wikilinks found in
/// string scalars into `index`.  This mirrors the `collect_cited` helper in
/// `dangling_reference.rs` but writes into the backlink index instead of a set.
fn collect_frontmatter_wikilinks(
    value: &serde_yaml::Value,
    source_name: &str,
    index: &mut HashMap<String, Vec<String>>,
) {
    match value {
        serde_yaml::Value::String(s) => {
            for link in extract(s) {
                let target_name = resolve_name(&link.target).to_lowercase();
                index
                    .entry(target_name)
                    .or_default()
                    .push(source_name.to_string());
            }
        }
        serde_yaml::Value::Sequence(items) => {
            for item in items {
                collect_frontmatter_wikilinks(item, source_name, index);
            }
        }
        serde_yaml::Value::Mapping(map) => {
            for (_key, val) in map {
                collect_frontmatter_wikilinks(val, source_name, index);
            }
        }
        // Bool, Number, Null, Tagged — nothing to extract.
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_simple() {
        let links = extract("See [[My Note]] for details.");
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target, "My Note");
        assert_eq!(links[0].alias, None);
    }

    #[test]
    fn test_extract_with_alias() {
        let links = extract("Check [[path/to/Note|display text]].");
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target, "path/to/Note");
        assert_eq!(links[0].alias, Some("display text".into()));
    }

    #[test]
    fn test_extract_multiple() {
        let links = extract("[[A]] and [[B|bee]] and [[C]]");
        assert_eq!(links.len(), 3);
    }

    #[test]
    fn test_strip() {
        assert_eq!(strip("[[Note]]"), "Note");
        assert_eq!(strip("[[path/Note|Display]]"), "Display");
        assert_eq!(strip("See [[A]] and [[B|b]]"), "See A and b");
    }

    #[test]
    fn test_resolve_name() {
        assert_eq!(resolve_name("41 projects/nix/Nix"), "Nix");
        assert_eq!(resolve_name("Simple"), "Simple");
    }

    // --- TDD: resolve_name with dots, anchors, and path components ---

    #[test]
    fn test_resolve_name_dot_in_filename_rebase() {
        assert_eq!(
            resolve_name("rebase.updateRefs auto-moves branch pointers"),
            "rebase.updateRefs auto-moves branch pointers"
        );
    }

    #[test]
    fn test_resolve_name_dot_in_filename_validation() {
        assert_eq!(resolve_name("Validation v0.4"), "Validation v0.4");
    }

    #[test]
    fn test_resolve_name_dot_in_filename_cyrillic() {
        assert_eq!(
            resolve_name("A. Общеутвердительное суждение"),
            "A. Общеутвердительное суждение"
        );
    }

    #[test]
    fn test_resolve_name_dot_in_filename_tilde_domain() {
        assert_eq!(resolve_name("~vadirn.io"), "~vadirn.io");
    }

    #[test]
    fn test_resolve_name_heading_anchor() {
        assert_eq!(resolve_name("Note#Some Heading"), "Note");
    }

    #[test]
    fn test_resolve_name_block_ref_anchor() {
        assert_eq!(resolve_name("Note#^block-ref-id"), "Note");
    }

    #[test]
    fn test_resolve_name_path_with_md_extension() {
        assert_eq!(resolve_name("20 cards/Foo.md"), "Foo");
    }

    #[test]
    fn test_resolve_name_md_extension() {
        assert_eq!(resolve_name("Foo.md"), "Foo");
    }

    #[test]
    fn test_extract_tracks_line() {
        let content = "line1 [[A]]\nline2 stuff\nline3 [[B]] and [[C]]";
        let links = extract(content);
        assert_eq!(links.len(), 3);
        assert_eq!(links[0].target, "A");
        assert_eq!(links[0].line, 1);
        assert_eq!(links[1].target, "B");
        assert_eq!(links[1].line, 3);
        assert_eq!(links[2].target, "C");
        assert_eq!(links[2].line, 3);
    }

    // --- Failing tests: fenced code block suppression ---

    #[test]
    fn test_extract_skips_wikilink_in_backtick_fence() {
        let links = extract("```\n[[Note]]\n```");
        assert_eq!(links.len(), 0);
    }

    #[test]
    fn test_extract_skips_wikilink_in_tilde_fence() {
        let links = extract("~~~\n[[Note]]\n~~~");
        assert_eq!(links.len(), 0);
    }

    #[test]
    fn test_extract_skips_wikilink_in_fenced_bash_info_string() {
        let links = extract("```bash\n[[ -z $VAR ]] && echo hi\n```");
        assert_eq!(links.len(), 0);
    }

    #[test]
    fn test_extract_skips_bash_array_syntax_in_fence() {
        let content = "```bash\nif [[ \"$result\" == *\"text\"* ]]; then\n  echo ok\nfi\n```";
        let links = extract(content);
        assert_eq!(links.len(), 0);
    }

    #[test]
    fn test_extract_yields_wikilink_after_fence() {
        let content = "```\n[[Skip]]\n```\n[[Keep]]";
        let links = extract(content);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target, "Keep");
    }

    #[test]
    fn test_extract_line_number_correct_after_fence() {
        // "```\n[[Skip]]\n```\n[[Keep]]": fence is lines 1-3, [[Keep]] is on line 4.
        let content = "```\n[[Skip]]\n```\n[[Keep]]";
        let links = extract(content);
        assert_eq!(links[0].line, 4);
    }

    // --- Failing tests: inline code span suppression ---

    #[test]
    fn test_extract_skips_wikilink_in_single_backtick_span() {
        let links = extract("See `[[wikilink]]` for details.");
        assert_eq!(links.len(), 0);
    }

    #[test]
    fn test_extract_skips_wikilink_in_double_backtick_span() {
        let links = extract("See ``[[wikilink]]`` for details.");
        assert_eq!(links.len(), 0);
    }

    #[test]
    fn test_extract_yields_wikilink_outside_backtick_span() {
        let content = "`[[Skip]]` and [[Keep]]";
        let links = extract(content);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target, "Keep");
    }

    // --- Failing tests: YAML frontmatter suppression ---

    #[test]
    fn test_extract_skips_wikilink_in_frontmatter_yaml_string() {
        let content = "---\nfrictions:\n  - \"[[ -z $VAR ]] guard\"\n---\n[[Real]]";
        let links = extract(content);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target, "Real");
    }

    // --- Tests: backlink index includes frontmatter wikilinks ---

    fn make_file(
        name: &str,
        content: &str,
        frontmatter: std::collections::BTreeMap<String, serde_yaml::Value>,
    ) -> crate::vault::VaultFile {
        crate::vault::VaultFile {
            name: name.to_string(),
            path: std::path::PathBuf::from(format!("/vault/{}.md", name)),
            frontmatter,
            frontmatter_error: None,
            content: content.to_string(),
            ctime: None,
        }
    }

    #[test]
    fn test_backlink_index_includes_frontmatter_wikilink() {
        // File A has no body wikilinks; its frontmatter contains `project: "[[B]]"`.
        // Expect index["b"] to contain "A".
        let mut fm = std::collections::BTreeMap::new();
        fm.insert(
            "project".to_string(),
            serde_yaml::Value::String("[[B]]".to_string()),
        );
        let file_a = make_file("A", "no links here", fm);
        let index = build_backlink_index(&[file_a]);
        let entry = index.get("b").expect("expected \"b\" in backlink index");
        assert!(entry.contains(&"A".to_string()), "expected A in index[\"b\"]");
    }

    #[test]
    fn test_backlink_index_frontmatter_array() {
        // File A's frontmatter has `references: ["[[B]]", "[[C]]"]`.
        // Expect both index["b"] and index["c"] to contain "A".
        let mut fm = std::collections::BTreeMap::new();
        fm.insert(
            "references".to_string(),
            serde_yaml::Value::Sequence(vec![
                serde_yaml::Value::String("[[B]]".to_string()),
                serde_yaml::Value::String("[[C]]".to_string()),
            ]),
        );
        let file_a = make_file("A", "", fm);
        let index = build_backlink_index(&[file_a]);
        assert!(
            index.get("b").map_or(false, |v| v.contains(&"A".to_string())),
            "expected A in index[\"b\"]"
        );
        assert!(
            index.get("c").map_or(false, |v| v.contains(&"A".to_string())),
            "expected A in index[\"c\"]"
        );
    }

    #[test]
    fn test_backlink_index_combines_body_and_frontmatter() {
        // File A body links to [[B]]; frontmatter has `project: "[[C]]"`.
        // Both index["b"] and index["c"] must contain "A".
        let mut fm = std::collections::BTreeMap::new();
        fm.insert(
            "project".to_string(),
            serde_yaml::Value::String("[[C]]".to_string()),
        );
        let file_a = make_file("A", "See [[B]] for details.", fm);
        let index = build_backlink_index(&[file_a]);
        assert!(
            index.get("b").map_or(false, |v| v.contains(&"A".to_string())),
            "expected A in index[\"b\"]"
        );
        assert!(
            index.get("c").map_or(false, |v| v.contains(&"A".to_string())),
            "expected A in index[\"c\"]"
        );
    }

    #[test]
    fn test_backlink_index_ignores_non_wikilink_strings() {
        // Frontmatter has plain text; no spurious index entries should appear.
        let mut fm = std::collections::BTreeMap::new();
        fm.insert(
            "description".to_string(),
            serde_yaml::Value::String("just text".to_string()),
        );
        let file_a = make_file("A", "", fm);
        let index = build_backlink_index(&[file_a]);
        // The index should be empty (no wikilinks anywhere).
        assert!(index.is_empty(), "expected empty index, got: {:?}", index);
    }

    #[test]
    fn test_backlink_index_handles_nested_yaml() {
        // Frontmatter has `meta: { project: "[[B]]" }`.
        // The recursive walk must reach the inner string.
        let mut inner = serde_yaml::Mapping::new();
        inner.insert(
            serde_yaml::Value::String("project".to_string()),
            serde_yaml::Value::String("[[B]]".to_string()),
        );
        let mut fm = std::collections::BTreeMap::new();
        fm.insert(
            "meta".to_string(),
            serde_yaml::Value::Mapping(inner),
        );
        let file_a = make_file("A", "", fm);
        let index = build_backlink_index(&[file_a]);
        assert!(
            index.get("b").map_or(false, |v| v.contains(&"A".to_string())),
            "expected A in index[\"b\"] via nested YAML walk"
        );
    }

    // --- Failing tests: CRLF and frontmatter line-offset arithmetic ---

    #[test]
    fn test_extract_handles_crlf_content() {
        let content = "line1\r\nline2 [[Note]]\r\nline3";
        let links = extract(content);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target, "Note");
        assert_eq!(links[0].line, 2);
    }

    #[test]
    fn test_extract_frontmatter_line_offset() {
        // 5-line frontmatter block:
        //   line 1: ---
        //   line 2: title: Foo
        //   line 3: tags:
        //   line 4:   - a
        //   line 5: ---
        //   line 6: [[Body]]
        //
        // frontmatter::body() returns "\n[[Body]]" (starts at the \n after closing ---).
        // The rewritten extract will feed body() to the parser and add a frontmatter_line_offset
        // equal to the number of newlines before the body slice. Those 5 newlines (one per
        // frontmatter line) plus the leading \n in the body slice shift [[Body]] to line 6.
        let content = "---\ntitle: Foo\ntags:\n  - a\n---\n[[Body]]";
        let links = extract(content);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target, "Body");
        // body() returns "\n[[Body]]"; within that slice [[Body]] is on line 2 (1-based).
        // frontmatter_line_offset = 5 (newlines in content before the body slice starts).
        // Reported line = offset + line-within-body = 5 + 1 = 6... but body slice starts
        // with \n so [[Body]] appears on line 2 of the body slice, offset adds 4 (newlines
        // before the \n that begins the body). Either way the expected absolute line is 6.
        assert_eq!(links[0].line, 6);
    }
}
