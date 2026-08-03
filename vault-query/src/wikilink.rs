use regex::Regex;
use std::collections::HashMap;
use std::sync::LazyLock;
use unicode_normalization::UnicodeNormalization;

static WIKILINK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[\[([^\]|]+)(?:\|([^\]]*))?\]\]").unwrap());

/// A parsed wikilink.
#[derive(Debug, Clone, PartialEq)]
pub struct Wikilink {
    pub target: String,        // the link target (path or name)
    pub alias: Option<String>, // display alias if present
    pub line: u32,             // 1-based line number where the link appears
}

/// Extract all wikilinks from content.
///
/// Parses via mdstruct (comrak-backed) and maps each `Inline::Wikilink` to a
/// [`Wikilink`], copying the schema-1.1 `target`/`alias` fields directly rather
/// than re-slicing spans or re-running [`WIKILINK_RE`]. Those two fields are
/// reliable decoded strings even inside escaped-pipe table cells, where comrak's
/// inline byte spans shift onto non-char boundaries.
///
/// Suppression is inherited from mdstruct: wikilinks inside fenced code blocks
/// and inline code spans do not appear as `Inline::Wikilink`, and YAML
/// frontmatter is treated as opaque, so `inlines()` already excludes any
/// wikilink written inside a `---...---` block. Embed wikilinks (`![[X]]`,
/// `embed: true`) ARE included — comrak emits them with `target = X`, matching
/// the prior pulldown+regex behaviour.
///
/// `line` is mdstruct's `start_line`: 1-based over the whole document, counting
/// frontmatter lines, which matches the absolute-line numbering callers expect.
///
/// Dual use: called both on whole file content and on individual YAML
/// frontmatter scalar strings (via [`walk_frontmatter_links`]). A bare scalar
/// won't begin with `---\n`, so mdstruct parses it as body and emits its
/// wikilink normally.
pub fn extract(content: &str) -> Vec<Wikilink> {
    let doc = mdstruct::parse(content, &mdstruct::Options { wikilinks: true });

    doc.inlines()
        .iter()
        .filter_map(|inline| match inline {
            mdstruct::Inline::Wikilink {
                target,
                alias,
                start_line,
                ..
            } => Some(Wikilink {
                target: target.clone(),
                alias: alias.clone(),
                line: *start_line,
            }),
            _ => None,
        })
        .collect()
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

/// Canonical join key for the backlink index: the resolved note name
/// ([`resolve_name`]) run through [`normalize`]. Both index construction and
/// lookup MUST key through this one function so a wikilink target and the note
/// it points at collapse to the same key regardless of folder prefix,
/// `.md`/`#anchor` suffix, or NFKC/case differences.
pub fn backlink_key(target: &str) -> String {
    normalize(resolve_name(target))
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
pub fn build_backlink_index(files: &[crate::vault::VaultFile]) -> HashMap<String, Vec<String>> {
    let body_links: Vec<Vec<Wikilink>> = files.iter().map(|f| extract(&f.content)).collect();
    build_backlink_index_with(files, &body_links)
}

/// Like [`build_backlink_index`], but takes pre-extracted body wikilinks
/// (parallel to `files`) so callers that already parsed every file reuse the
/// result instead of paying a second Markdown parse per file.
pub fn build_backlink_index_with(
    files: &[crate::vault::VaultFile],
    body_links: &[Vec<Wikilink>],
) -> HashMap<String, Vec<String>> {
    let mut index: HashMap<String, Vec<String>> = HashMap::new();
    for (file, links) in files.iter().zip(body_links) {
        // Wikilinks from the Markdown body.
        for link in links {
            let target_name = backlink_key(&link.target);
            index
                .entry(target_name)
                .or_default()
                .push(file.name.clone());
        }
        // Wikilinks from every YAML frontmatter scalar value.
        for value in file.frontmatter.values() {
            walk_frontmatter_links(value, &mut |link| {
                let target_name = backlink_key(&link.target);
                index
                    .entry(target_name)
                    .or_default()
                    .push(file.name.clone());
            });
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
        walk_frontmatter_links(value, &mut |link| {
            if seen.insert(link.target.clone()) {
                result.push(link.target);
            }
        });
    }

    result
}

/// Wikilinks recovered from a file's YAML frontmatter block.
///
/// Two populations, because YAML gives `[[` a meaning of its own and the two
/// readings are opposite defects:
///
/// - `resolved` — links the parsed tree yielded as string scalars, the form
///   Obsidian writes (`key: "[[X]]"`). Targets come from the parse, never from
///   the raw text, so a genuine nested array (`key: [[a, b]]`) can never invent
///   the target `a, b`.
/// - `unquoted` — `[[...]]` occurrences present in the raw frontmatter text
///   that the parse turned into a one-element flow sequence instead of a
///   string. That is an author writing a link YAML then ate: every scalar-only
///   consumer, this one included, is blind to it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FrontmatterLinks {
    /// Links from YAML string scalars, carrying absolute file line numbers,
    /// ordered by line.
    pub resolved: Vec<Wikilink>,
    /// Raw `[[...]]` occurrences YAML swallowed into a nested sequence.
    pub unquoted: Vec<Wikilink>,
}

/// One `[[...]]` occurrence located in the raw frontmatter text.
struct RawOccurrence {
    /// Text between the brackets, verbatim — `X` for `[[X]]`, `X|Y` for
    /// `[[X|Y]]`. Compared against the YAML parse to tell an eaten link from a
    /// real array.
    inner: String,
    target: String,
    alias: Option<String>,
    /// 1-based line in the whole file. Frontmatter opens on line 1, so no
    /// offset arithmetic is needed to reach absolute numbering.
    line: u32,
}

/// Scan the raw frontmatter block for `[[...]]` occurrences, with file lines.
///
/// `frontmatter::body_start_line` reports the line after the closing `---`, so
/// the block's inner lines are 2 ..= `body_start_line - 2`. A file with no
/// complete block (or an empty one) yields nothing.
///
/// This is a text scan, deliberately: its only job is to supply line numbers
/// and to expose what the parse dropped. It never decides a link target on its
/// own — that stays with the YAML parse.
fn scan_raw_frontmatter(content: &str) -> Vec<RawOccurrence> {
    let inner_lines = crate::frontmatter::body_start_line(content).saturating_sub(3);
    let mut out = Vec::new();
    for (idx, line) in content.lines().enumerate().skip(1).take(inner_lines) {
        for caps in WIKILINK_RE.captures_iter(line) {
            let whole = caps.get(0).unwrap().as_str();
            out.push(RawOccurrence {
                inner: whole[2..whole.len() - 2].to_string(),
                target: caps[1].to_string(),
                alias: caps.get(2).map(|m| m.as_str().to_string()),
                line: (idx + 1) as u32,
            });
        }
    }
    out
}

/// Every string that appears as the sole element of a YAML sequence, anywhere
/// in the tree.
///
/// This is the fingerprint an eaten link leaves. `key: [[X]]` parses to
/// `Sequence([Sequence([String("X")])])`, so the inner one-element sequence
/// holds exactly the text between the brackets. A genuine nested array
/// `key: [[a, b]]` leaves a two-element inner sequence and never lands here,
/// which is what keeps it out of the quoting rule.
fn single_string_sequences(
    frontmatter: &std::collections::BTreeMap<String, serde_yaml::Value>,
) -> std::collections::HashSet<String> {
    fn walk(value: &serde_yaml::Value, out: &mut std::collections::HashSet<String>) {
        match value {
            serde_yaml::Value::Sequence(items) => {
                if let [serde_yaml::Value::String(s)] = items.as_slice() {
                    out.insert(s.clone());
                }
                for item in items {
                    walk(item, out);
                }
            }
            serde_yaml::Value::Mapping(map) => {
                for (_key, val) in map {
                    walk(val, out);
                }
            }
            _ => {}
        }
    }
    let mut out = std::collections::HashSet::new();
    for value in frontmatter.values() {
        walk(value, &mut out);
    }
    out
}

/// Extract a file's frontmatter wikilinks: see [`FrontmatterLinks`].
///
/// `content` is the whole file (frontmatter included); `frontmatter` is its
/// parsed tree, as `VaultFile` carries both.
///
/// Targets come from the parse ([`walk_frontmatter_links`], string scalars
/// only). Line numbers come from the raw block, because `serde_yaml::Value`
/// carries no spans: each parsed link claims the first raw occurrence naming
/// the same target, and raw occurrences left over after every parsed link has
/// claimed one are candidates for the quoting defect. A parsed link that
/// matches no raw occurrence — only reachable through a YAML escape that
/// rewrites the text, e.g. `"[[Foo]]"` — falls back to line 1.
///
/// `frontmatter` is a `BTreeMap`, so the parse visits keys alphabetically
/// rather than in file order; sorting the result by line restores file order.
pub fn frontmatter_links(
    content: &str,
    frontmatter: &std::collections::BTreeMap<String, serde_yaml::Value>,
) -> FrontmatterLinks {
    let raw = scan_raw_frontmatter(content);
    if raw.is_empty() {
        return FrontmatterLinks::default();
    }

    let mut parsed: Vec<Wikilink> = Vec::new();
    for value in frontmatter.values() {
        walk_frontmatter_links(value, &mut |link| parsed.push(link));
    }

    let mut claimed = vec![false; raw.len()];
    let mut resolved = Vec::with_capacity(parsed.len());
    for link in parsed {
        let found = raw
            .iter()
            .enumerate()
            .find(|(i, o)| !claimed[*i] && o.target.trim() == link.target.trim())
            .map(|(i, o)| (i, o.line));
        let line = match found {
            Some((i, line)) => {
                claimed[i] = true;
                line
            }
            None => 1,
        };
        resolved.push(Wikilink { line, ..link });
    }
    resolved.sort_by_key(|link| link.line);

    let singles = single_string_sequences(frontmatter);
    let unquoted = raw
        .iter()
        .enumerate()
        .filter(|(i, o)| !claimed[*i] && singles.contains(o.inner.trim()))
        .map(|(_, o)| Wikilink {
            target: o.target.clone(),
            alias: o.alias.clone(),
            line: o.line,
        })
        .collect();

    FrontmatterLinks { resolved, unquoted }
}

/// Recursively walk a `serde_yaml::Value` and call `f` on every wikilink found
/// in string scalars.  Sequences and mapping values are descended into; other
/// scalar kinds (Bool, Number, Null, Tagged) carry no links.  Single traversal
/// shared by the backlink index, `collect_all_link_targets`, and the
/// dangling-reference lint rule.
pub(crate) fn walk_frontmatter_links<F: FnMut(Wikilink)>(value: &serde_yaml::Value, f: &mut F) {
    match value {
        serde_yaml::Value::String(s) => {
            for link in extract(s) {
                f(link);
            }
        }
        serde_yaml::Value::Sequence(items) => {
            for item in items {
                walk_frontmatter_links(item, f);
            }
        }
        serde_yaml::Value::Mapping(map) => {
            for (_key, val) in map {
                walk_frontmatter_links(val, f);
            }
        }
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
        assert!(
            entry.contains(&"A".to_string()),
            "expected A in index[\"b\"]"
        );
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
            index.get("b").is_some_and(|v| v.contains(&"A".to_string())),
            "expected A in index[\"b\"]"
        );
        assert!(
            index.get("c").is_some_and(|v| v.contains(&"A".to_string())),
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
            index.get("b").is_some_and(|v| v.contains(&"A".to_string())),
            "expected A in index[\"b\"]"
        );
        assert!(
            index.get("c").is_some_and(|v| v.contains(&"A".to_string())),
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
        fm.insert("meta".to_string(), serde_yaml::Value::Mapping(inner));
        let file_a = make_file("A", "", fm);
        let index = build_backlink_index(&[file_a]);
        assert!(
            index.get("b").is_some_and(|v| v.contains(&"A".to_string())),
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

    // --- Tests: frontmatter link extraction ---

    fn fm_links(content: &str) -> FrontmatterLinks {
        let fm = crate::frontmatter::parse(content)
            .unwrap()
            .unwrap_or_default();
        frontmatter_links(content, &fm)
    }

    #[test]
    fn test_frontmatter_links_quoted_scalar_carries_absolute_line() {
        let content = "---\ntype: ticket\nproject: \"[[41 projects/nix/Nix]]\"\n---\nBody.";
        let links = fm_links(content);
        assert_eq!(links.resolved.len(), 1);
        assert_eq!(links.resolved[0].target, "41 projects/nix/Nix");
        assert_eq!(links.resolved[0].line, 3);
        assert!(links.unquoted.is_empty());
    }

    #[test]
    fn test_frontmatter_links_sequence_yields_one_link_per_element() {
        let content = "---\nrequires:\n  - \"[[a]]\"\n  - \"[[b]]\"\n---\nBody.";
        let links = fm_links(content);
        let targets: Vec<&str> = links.resolved.iter().map(|l| l.target.as_str()).collect();
        assert_eq!(targets, vec!["a", "b"]);
        assert_eq!(links.resolved[0].line, 3);
        assert_eq!(links.resolved[1].line, 4);
    }

    #[test]
    fn test_frontmatter_links_are_ordered_by_line_not_by_key() {
        // `frontmatter` is a BTreeMap, so the parse visits `project` before
        // `zzz` regardless of file order; the result must still read top-down.
        let content = "---\nzzz: \"[[Later]]\"\nproject: \"[[Earlier]]\"\n---\nBody.";
        let links = fm_links(content);
        assert_eq!(links.resolved.len(), 2);
        assert_eq!(links.resolved[0].target, "Later");
        assert_eq!(links.resolved[0].line, 2);
        assert_eq!(links.resolved[1].target, "Earlier");
        assert_eq!(links.resolved[1].line, 3);
    }

    #[test]
    fn test_frontmatter_links_unquoted_link_is_not_resolved_but_is_reported() {
        let content = "---\nproject: [[X]]\n---\nBody.";
        let links = fm_links(content);
        assert!(links.resolved.is_empty());
        assert_eq!(links.unquoted.len(), 1);
        assert_eq!(links.unquoted[0].target, "X");
        assert_eq!(links.unquoted[0].line, 2);
    }

    #[test]
    fn test_frontmatter_links_nested_array_yields_nothing() {
        let content = "---\nmatrix: [[a, b]]\n---\nBody.";
        let links = fm_links(content);
        assert!(links.resolved.is_empty());
        assert!(links.unquoted.is_empty());
    }

    #[test]
    fn test_frontmatter_links_ignores_body_wikilinks() {
        let content = "---\ntype: note\n---\nBody with [[Target]].";
        let links = fm_links(content);
        assert!(links.resolved.is_empty());
        assert!(links.unquoted.is_empty());
    }

    #[test]
    fn test_frontmatter_links_absent_block_yields_nothing() {
        let links = fm_links("No frontmatter, just [[Target]].");
        assert!(links.resolved.is_empty());
        assert!(links.unquoted.is_empty());
    }

    #[test]
    fn test_frontmatter_links_alias_is_preserved() {
        let content = "---\nproject: \"[[Nix|the flake]]\"\n---\nBody.";
        let links = fm_links(content);
        assert_eq!(links.resolved.len(), 1);
        assert_eq!(links.resolved[0].target, "Nix");
        assert_eq!(links.resolved[0].alias, Some("the flake".into()));
        assert_eq!(links.resolved[0].line, 2);
    }

    // --- Tests: 1.1 gains from mdstruct migration ---

    #[test]
    fn test_extract_table_cell_wikilink() {
        // A wikilink inside a GFM table cell. The escaped `\|` is the alias
        // separator (an unescaped `|` would end the column), so comrak's inline
        // span shifts onto a non-char boundary — the old pulldown+span path
        // dropped this; the 1.1 `target`/`alias` fields capture it directly.
        let content = "| col |\n|---|\n| [[Target\\|Alias]] |\n";
        let links = extract(content);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target, "Target");
        assert_eq!(links[0].alias, Some("Alias".into()));
    }

    #[test]
    fn test_extract_table_cell_embed() {
        // An embed wikilink inside a table cell is captured as a link to its
        // target (embeds are not filtered out).
        let content = "| col |\n|---|\n| ![[Embedded]] |\n";
        let links = extract(content);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target, "Embedded");
    }

    #[test]
    fn test_extract_embed_wikilink() {
        // `![[X]]` outside a table is captured as a link to X, matching the
        // prior pulldown+regex behaviour.
        let links = extract("![[Diagram]]");
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target, "Diagram");
    }

    #[test]
    fn test_extract_empty_pipe_alias() {
        // The empty-pipe form `[[X|]]` carries an alias of `Some("")` (a pipe is
        // present but the display text is empty), distinct from the no-pipe
        // `[[X]]` which is `None`.
        let links = extract("[[X|]]");
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target, "X");
        assert_eq!(links[0].alias, Some(String::new()));
    }
}
