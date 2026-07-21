//! `mdread` — a progressive-unfolding structured Markdown reader.
//!
//! Renders a Markdown file's heading tree folded to one line per section (with
//! line and estimated-token stats), or smart-unfolds one addressed section.
//! Structure comes from the shared [`mdstruct`] core; everything here is the
//! reader's own policy — the fold thresholds, the token estimate, the address
//! scheme, and the rendered shapes.
//!
//! Every rendered slice is cut from the original bytes: the reader never
//! restringifies the source.

mod facet;
mod format;
mod frontmatter;
mod model;
mod render;
mod resolve;
mod slug;
mod tokens;
mod unfold;
mod wikilink;

use std::path::Path;

use anyhow::Result;

pub use facet::HeadingRule;
pub use format::TextJson;

use model::{Document, node_tokens, parse_document_with, range_lines, range_slice};
use render::{OverviewJson, TextNodeJson, node_to_json, print_tree_line};
use resolve::resolve_address;
use unfold::{UnfoldJson, own_prose, unfold_child_json, unfold_content_string};

/// Default inline cutoff in estimated tokens for the unfold heuristic.
pub const DEFAULT_THRESHOLD: usize = 2000;

/// Read `file` and render it: a folded overview when `address` is `None`, or the
/// smart-unfolded addressed section otherwise.
pub fn run(
    file: &Path,
    address: Option<&str>,
    depth: Option<usize>,
    full: bool,
    threshold: Option<usize>,
    format: TextJson,
    heading_rule: HeadingRule,
) -> Result<()> {
    let content = std::fs::read_to_string(file)
        .map_err(|e| anyhow::anyhow!("Cannot read {}: {}", file.display(), e))?;
    run_content(
        &file.display().to_string(),
        &content,
        address,
        depth,
        full,
        threshold,
        format,
        heading_rule,
    )
}

/// Render already-loaded `content`, labelled `display_path` in the output. Lets a
/// caller read from stdin or an in-memory buffer.
#[allow(clippy::too_many_arguments)]
pub fn run_content(
    display_path: &str,
    content: &str,
    address: Option<&str>,
    depth: Option<usize>,
    full: bool,
    threshold: Option<usize>,
    format: TextJson,
    heading_rule: HeadingRule,
) -> Result<()> {
    let doc = parse_document_with(content, heading_rule);
    let threshold = threshold.unwrap_or(DEFAULT_THRESHOLD);

    match address {
        None => emit_overview(display_path, content, &doc, format),
        // Frontmatter is addressed before the heading tree: it sits above
        // `body_start`, so it is not a node the tree can resolve.
        Some(addr) if frontmatter_address(addr).is_some() => {
            let which = frontmatter_address(addr).expect("checked by the guard");
            emit_frontmatter(display_path, content, addr, which, format)
        }
        Some(addr) => emit_section(display_path, &doc, addr, depth, full, threshold, format),
    }
}

/// Which part of the frontmatter an address names.
enum FmAddress<'a> {
    /// The whole block (`frontmatter`, `fm`).
    Block,
    /// One entry by key (`fm.tags`, `frontmatter.tags`).
    Field(&'a str),
}

/// Recognize a frontmatter address, case-insensitively. Returns `None` for any
/// address that is not frontmatter, leaving it to the heading-tree resolver.
///
/// The prefixes are ASCII, so lowercasing preserves their byte length and the
/// key can be sliced out of the original (case-preserving) address.
fn frontmatter_address(addr: &str) -> Option<FmAddress<'_>> {
    let lower = addr.to_lowercase();
    if lower == "frontmatter" || lower == "fm" {
        return Some(FmAddress::Block);
    }
    for prefix in ["frontmatter.", "fm."] {
        if lower.starts_with(prefix) {
            let key = &addr[prefix.len()..];
            if !key.is_empty() {
                return Some(FmAddress::Field(key));
            }
        }
    }
    None
}

#[derive(serde::Serialize)]
struct FieldJson {
    key: String,
    value: String,
    line: usize,
}

#[derive(serde::Serialize)]
struct FrontmatterJson {
    path: String,
    address: String,
    line: usize,
    lines: usize,
    fields: Vec<FieldJson>,
}

#[derive(serde::Serialize)]
struct FrontmatterFieldJson {
    path: String,
    address: String,
    key: String,
    value: String,
    line: usize,
}

/// Frontmatter path: print the raw block, or one entry's value.
fn emit_frontmatter(
    display_path: &str,
    content: &str,
    address: &str,
    which: FmAddress<'_>,
    format: TextJson,
) -> Result<()> {
    let Some(text) = frontmatter::block_text(content) else {
        return Err(anyhow::anyhow!(
            "No frontmatter block in this file (address '{}')",
            address
        ));
    };

    match which {
        FmAddress::Field(key) => {
            let Some(f) = frontmatter::field(content, key) else {
                let known: Vec<String> = frontmatter::field_order(content);
                return Err(anyhow::anyhow!(
                    "No frontmatter field '{}'; present: {}",
                    key,
                    known.join(", ")
                ));
            };
            if format == TextJson::Json {
                let out = FrontmatterFieldJson {
                    path: display_path.to_string(),
                    address: address.to_string(),
                    key: f.key,
                    value: f.value,
                    line: f.line,
                };
                println!("{}", serde_json::to_string_pretty(&out)?);
            } else {
                println!("{}", f.value);
            }
        }
        FmAddress::Block => {
            let (start, end) = frontmatter::block_line_range(content).unwrap_or((1, 0));
            if format == TextJson::Json {
                let fields = frontmatter::fields_with_values(content)
                    .into_iter()
                    .map(|f| FieldJson {
                        key: f.key,
                        value: f.value,
                        line: f.line,
                    })
                    .collect();
                let out = FrontmatterJson {
                    path: display_path.to_string(),
                    address: address.to_string(),
                    line: start,
                    lines: range_lines(start, end),
                    fields,
                };
                println!("{}", serde_json::to_string_pretty(&out)?);
            } else {
                println!(
                    "{}  (frontmatter)   L{}   {} lines",
                    address,
                    start,
                    range_lines(start, end)
                );
                println!();
                println!("{}", text);
            }
        }
    }
    Ok(())
}

/// Overview path (no address).
fn emit_overview(
    display_path: &str,
    content: &str,
    doc: &Document,
    format: TextJson,
) -> Result<()> {
    // Scan the raw frontmatter block for top-level keys in source order, so the
    // listing reflects the file rather than an alphabetization.
    let fields: Vec<String> = frontmatter::field_order(content);
    let link_count = facet::link_count(content);

    if format == TextJson::Json {
        let text = doc.text.as_ref().map(|t| TextNodeJson {
            address: "0".to_string(),
            label: "(text)".to_string(),
            line: t.line,
            lines: range_lines(t.start, t.end),
            tokens: tokens::estimate_tokens(
                &range_slice(&doc.lines, t.start, t.end).unwrap_or_default(),
            ),
        });
        let tree = doc
            .tree
            .iter()
            .map(|n| node_to_json(n, &doc.lines))
            .collect();
        let out = OverviewJson {
            path: display_path.to_string(),
            fields,
            links: link_count,
            text,
            tree,
        };
        println!("{}", serde_json::to_string_pretty(&out)?);
        return Ok(());
    }

    // Text overview.
    println!("{}", display_path);
    if !fields.is_empty() {
        println!("fields: {}", fields.join(", "));
    }
    println!("links: {}", link_count);
    println!();

    if let Some(t) = &doc.text {
        let lines = range_lines(t.start, t.end);
        let toks =
            tokens::estimate_tokens(&range_slice(&doc.lines, t.start, t.end).unwrap_or_default());
        // Two leading spaces to align under the `+`/space marker column.
        println!(
            "  [0]  (text)        L{}   {} lines · ~{} tok",
            t.line, lines, toks
        );
    }

    for n in &doc.tree {
        print_tree_line(n, &doc.lines);
    }

    println!();
    // Tool-agnostic: names addresses, not a command, so both the `mdread` CLI and
    // the `vault-query read` wrapper print something true of themselves.
    println!("next: <addr> unfolds a section · fm the frontmatter · fm.<key> one field");
    Ok(())
}

/// With-address path: smart-unfold the addressed node.
///
/// Text: the node header, then its own prose, then for each direct child either
/// the inlined (recursively unfolded) text or a folded placeholder line
/// identical to the overview tree line.
fn emit_section(
    display_path: &str,
    doc: &Document,
    address: &str,
    depth: Option<usize>,
    full: bool,
    threshold: usize,
    format: TextJson,
) -> Result<()> {
    let n = resolve_address(doc, address)?;
    let lines = range_lines(n.start, n.end);
    let toks = node_tokens(n, &doc.lines);
    if format == TextJson::Json {
        let children = n
            .children
            .iter()
            .map(|c| unfold_child_json(c, &doc.lines, 1, depth, threshold, full))
            .collect();
        let out = UnfoldJson {
            path: display_path.to_string(),
            address: n.address.clone(),
            heading: n.heading.clone(),
            slug: n.slug.clone(),
            level: n.level,
            line: n.line,
            lines,
            tokens: toks,
            content: own_prose(n, &doc.lines),
            children,
        };
        println!("{}", serde_json::to_string_pretty(&out)?);
    } else {
        println!(
            "{}  {}   L{}   {} lines · ~{} tok",
            n.address, n.heading, n.line, lines, toks
        );
        println!();
        print!(
            "{}",
            unfold_content_string(n, &doc.lines, 0, depth, threshold, full)
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::format::TextJson;
    use crate::model::*;
    use crate::render::tree_line_string;
    use crate::resolve::{ResolveError, resolve, resolve_address};
    use crate::unfold::*;
    use std::str::FromStr;

    const SAMPLE: &str = "---\ntype: note\nslug: x\n---\n\nLede prose before any heading.\nSecond line of lede.\n\n# Direction\n\nDir body.\n\n## Sub one\n\nsub one body\n\n## Sub two\n\nsub two body\n\n# Glossary\n\ngloss body\n\n# Log & Notes\n\nfirst.\n\n# Log Notes\n\nsecond.\n";

    #[test]
    fn from_str_roundtrip() {
        assert_eq!(TextJson::from_str("text").unwrap(), TextJson::Text);
        assert_eq!(TextJson::from_str("json").unwrap(), TextJson::Json);
        assert_eq!(TextJson::from_str("JSON").unwrap(), TextJson::Json);
        assert!(TextJson::from_str("yaml").is_err());
        assert_eq!(TextJson::Text.to_string(), "text");
        assert_eq!(TextJson::Json.to_string(), "json");
    }

    #[test]
    fn tree_shape_and_addresses() {
        let doc = parse_document(SAMPLE);
        // Top-level: Direction(1), Glossary(2), Log & Notes(3), Log Notes(4).
        assert_eq!(doc.tree.len(), 4);
        assert_eq!(doc.tree[0].address, "1");
        assert_eq!(doc.tree[0].heading, "Direction");
        assert_eq!(doc.tree[0].children.len(), 2);
        assert_eq!(doc.tree[0].children[0].address, "1.1");
        assert_eq!(doc.tree[0].children[0].heading, "Sub one");
        assert_eq!(doc.tree[0].children[1].address, "1.2");
        assert_eq!(doc.tree[1].address, "2");
        assert_eq!(doc.tree[1].heading, "Glossary");
        assert!(doc.tree[1].children.is_empty());
    }

    #[test]
    fn content_range_includes_descendants() {
        let doc = parse_document(SAMPLE);
        let dir = &doc.tree[0];
        // Direction starts at its heading line and ends just before Glossary.
        let glossary_line = doc.tree[1].line;
        assert_eq!(dir.end, glossary_line - 1);
        // The Direction range therefore spans its two subsections.
        assert!(dir.end > dir.children[1].line);
    }

    #[test]
    fn text_region_detected_and_trimmed() {
        let doc = parse_document(SAMPLE);
        let t = doc.text.as_ref().expect("text region present");
        // Lede starts at the first non-blank body line (line 6), ends before `# Direction`.
        assert_eq!(t.line, 6);
        let first_heading = doc.tree[0].line;
        assert_eq!(t.end, first_heading - 1);
    }

    #[test]
    fn headingless_whole_body_is_text() {
        let content = "---\ntype: note\n---\n\nJust body.\nNo headings here.\n";
        let doc = parse_document(content);
        assert!(doc.tree.is_empty());
        let t = doc.text.as_ref().expect("text region present");
        assert_eq!(t.line, 5);
    }

    #[test]
    fn no_text_region_when_heading_first() {
        let content = "# Only Heading\n\nbody\n";
        let doc = parse_document(content);
        assert!(doc.text.is_none());
        assert_eq!(doc.tree.len(), 1);
    }

    #[test]
    fn fenced_hash_is_not_a_heading() {
        let content = "# Real\n\n```\n# not a heading\n```\n\n## Sub\n";
        let doc = parse_document(content);
        assert_eq!(doc.tree.len(), 1);
        assert_eq!(doc.tree[0].address, "1");
        assert_eq!(doc.tree[0].children.len(), 1);
        assert_eq!(doc.tree[0].children[0].heading, "Sub");
    }

    #[test]
    fn range_slice_out_of_bounds_is_none() {
        // Out-of-range requests return None (an explicit guard) rather than a
        // silent empty string or a slice-index panic.
        let lines = ["a", "b", "c"];
        assert_eq!(range_slice(&lines, 0, 2), None); // start before line 1
        assert_eq!(range_slice(&lines, 4, 5), None); // start past EOF
        assert_eq!(range_slice(&lines, 2, 1), None); // inverted end < start
        assert_eq!(range_slice(&lines, 1, 2).as_deref(), Some("a\nb"));
    }

    #[test]
    fn numeric_resolution() {
        let doc = parse_document(SAMPLE);
        let n = resolve(&doc, "1.2").expect("1.2 resolves");
        assert_eq!(n.address, "1.2");
        assert_eq!(n.heading, "Sub two");
    }

    #[test]
    fn slug_resolution() {
        let doc = parse_document(SAMPLE);
        let n = resolve(&doc, "glossary").expect("glossary resolves");
        assert_eq!(n.address, "2");
    }

    #[test]
    fn text_resolution() {
        let doc = parse_document(SAMPLE);
        // `0` and `text` both resolve to the synthetic text node.
        for addr in ["0", "text"] {
            let n = resolve(&doc, addr).expect("text node resolves");
            assert_eq!(n.address, "0");
            assert_eq!(n.heading, "(text)");
            assert_eq!(n.slug, "text");
        }
    }

    #[test]
    fn numeric_overflow_is_out_of_range_not_panic() {
        // An all-digit address that overflows usize must report out-of-range.
        let doc = parse_document(SAMPLE);
        match resolve(&doc, "99999999999999999999") {
            Err(ResolveError::OutOfRange(addr)) => assert_eq!(addr, "99999999999999999999"),
            _ => panic!("expected OutOfRange, got a different result"),
        }
    }

    #[test]
    fn numeric_past_end_is_out_of_range() {
        let doc = parse_document(SAMPLE);
        assert!(matches!(
            resolve(&doc, "99"),
            Err(ResolveError::OutOfRange(_))
        ));
    }

    #[test]
    fn no_slug_match_errors() {
        let doc = parse_document(SAMPLE);
        assert!(matches!(
            resolve(&doc, "nope"),
            Err(ResolveError::NoSlugMatch(_))
        ));
    }

    #[test]
    fn ambiguous_slug_errors_with_candidates() {
        let doc = parse_document(SAMPLE);
        match resolve(&doc, "log-notes") {
            Err(ResolveError::Ambiguous(needle, candidates)) => {
                assert_eq!(needle, "log-notes");
                assert_eq!(candidates.len(), 2);
            }
            _ => panic!("expected Ambiguous"),
        }
    }

    #[test]
    fn resolve_address_errors_instead_of_exiting() {
        // resolve_address returns a Result the caller propagates with `?` (no
        // process::exit), so the error path is unit-testable.
        let doc = parse_document(SAMPLE);
        let oob = resolve_address(&doc, "99").unwrap_err();
        assert!(oob.to_string().contains("out of range"), "got: {}", oob);
        let ambig = resolve_address(&doc, "log-notes").unwrap_err();
        let msg = ambig.to_string();
        assert!(msg.contains("Ambiguous"), "got: {}", msg);
        assert!(
            msg.contains("Log & Notes") && msg.contains("Log Notes"),
            "got: {}",
            msg
        );
        // A valid address still resolves to the node.
        assert_eq!(resolve_address(&doc, "2").unwrap().heading, "Glossary");
    }

    #[test]
    fn ambiguous_slug_detected() {
        let doc = parse_document(SAMPLE);
        // "Log & Notes" and "Log Notes" both slugify to "log-notes".
        let needle = crate::slug::segment("log-notes");
        let mut all = Vec::new();
        flatten(&doc.tree, &mut all);
        let matches: Vec<&Node> = all.into_iter().filter(|n| n.slug == needle).collect();
        assert_eq!(matches.len(), 2, "expected a slug collision in the fixture");
    }

    // A parent section with one small child (below threshold) and one large
    // child (above threshold), the large child carrying a grandchild. Exercises
    // the inline-vs-fold heuristic and the depth budget.
    const UNFOLD: &str = "# Sec\n\nsec prose.\n\n## Small\n\ntiny.\n\n## Large\n\nLLLL LLLL LLLL LLLL LLLL LLLL LLLL LLLL LLLL LLLL LLLL LLLL LLLL LLLL LLLL LLLL.\n\n### Grand\n\ngrand prose.\n";

    #[test]
    fn should_inline_by_threshold() {
        let doc = parse_document(UNFOLD);
        let sec = &doc.tree[0];
        let small = &sec.children[0];
        let large = &sec.children[1];
        let small_tok = node_tokens(small, &doc.lines);
        let large_tok = node_tokens(large, &doc.lines);
        assert!(small_tok < large_tok, "fixture should split on tokens");
        // Threshold between the two: small inlines, large folds.
        let cut = (small_tok + large_tok) / 2;
        assert!(should_inline(small, &doc.lines, 1, None, cut, false));
        assert!(!should_inline(large, &doc.lines, 1, None, cut, false));
        // `--full` overrides the threshold for the large child.
        assert!(should_inline(large, &doc.lines, 1, None, cut, true));
    }

    #[test]
    fn should_inline_by_depth() {
        let doc = parse_document(UNFOLD);
        let large = &doc.tree[0].children[1];
        let grand = &large.children[0];
        let big = usize::MAX; // threshold never binds
        // depth=1 admits level_depth 0 (direct children at level_depth 1 fail)…
        assert!(!should_inline(grand, &doc.lines, 1, Some(1), big, false));
        // …depth=2 admits level_depth 1.
        assert!(should_inline(grand, &doc.lines, 1, Some(2), big, false));
        // Unlimited depth admits any level.
        assert!(should_inline(grand, &doc.lines, 9, None, big, false));
    }

    #[test]
    fn own_prose_stops_at_first_child() {
        let doc = parse_document(UNFOLD);
        let sec = &doc.tree[0];
        let prose = own_prose(sec, &doc.lines);
        assert!(prose.contains("sec prose."), "own prose: {}", prose);
        assert!(
            !prose.contains("tiny."),
            "own prose must stop before first child: {}",
            prose
        );
    }

    #[test]
    fn folded_placeholder_matches_overview_line() {
        let doc = parse_document(UNFOLD);
        let large = &doc.tree[0].children[1];
        // The folded placeholder for a child equals that child's overview tree
        // line, so a reader can drill with the same address.
        let placeholder = tree_line_string(large, &doc.lines);
        assert!(placeholder.contains("1.2"), "placeholder: {}", placeholder);
        assert!(placeholder.contains("Large"), "placeholder: {}", placeholder);
        assert!(
            placeholder.trim_start().starts_with('+'),
            "Large has a child, marker '+': {}",
            placeholder
        );
    }

    #[test]
    fn unfold_content_inlines_small_folds_large() {
        let doc = parse_document(UNFOLD);
        let sec = &doc.tree[0];
        let small_tok = node_tokens(&sec.children[0], &doc.lines);
        let large_tok = node_tokens(&sec.children[1], &doc.lines);
        let cut = (small_tok + large_tok) / 2;
        let s = unfold_content_string(sec, &doc.lines, 0, None, cut, false);
        assert!(s.contains("sec prose."), "own prose present: {}", s);
        assert!(s.contains("tiny."), "small child inlined: {}", s);
        // Large child folded: its body absent, its placeholder line present.
        assert!(!s.contains("LLLL LLLL"), "large body must be folded out: {}", s);
        assert!(s.contains("1.2"), "large child placeholder present: {}", s);
    }

    // --- frontmatter addressing ---

    #[test]
    fn frontmatter_addresses_recognized_case_insensitively() {
        use crate::{FmAddress, frontmatter_address};
        for a in ["fm", "FM", "frontmatter", "Frontmatter"] {
            assert!(
                matches!(frontmatter_address(a), Some(FmAddress::Block)),
                "{a} should name the whole block"
            );
        }
        for a in ["fm.tags", "FM.tags", "frontmatter.tags"] {
            match frontmatter_address(a) {
                Some(FmAddress::Field(k)) => assert_eq!(k, "tags"),
                _ => panic!("{a} should name a field"),
            }
        }
        // A key keeps its own dots and its original case.
        match frontmatter_address("fm.My.Key") {
            Some(FmAddress::Field(k)) => assert_eq!(k, "My.Key"),
            _ => panic!("dotted key should survive"),
        }
    }

    #[test]
    fn non_frontmatter_addresses_fall_through_to_the_tree() {
        use crate::frontmatter_address;
        // Heading addresses, the text node, and a bare trailing dot are not
        // frontmatter, so the heading-tree resolver still owns them.
        for a in ["1", "1.2", "text", "0", "glossary", "fm.", "format"] {
            assert!(frontmatter_address(a).is_none(), "{a} must not be frontmatter");
        }
    }

    #[test]
    fn frontmatter_address_does_not_shadow_a_heading_tree_lookup() {
        // `fm` is intercepted before resolution, so a document whose heading
        // slugs to `fm` still resolves every other address normally.
        let doc = parse_document(SAMPLE);
        assert_eq!(resolve_address(&doc, "2").unwrap().heading, "Glossary");
    }

    #[test]
    fn numeric_address_predicate() {
        assert!(is_numeric_address("1"));
        assert!(is_numeric_address("1.2.3"));
        assert!(!is_numeric_address("1."));
        assert!(!is_numeric_address(".1"));
        assert!(!is_numeric_address("1.a"));
        assert!(!is_numeric_address("text"));
        assert!(!is_numeric_address(""));
    }

    #[test]
    fn bom_prefixed_frontmatter_is_skipped() {
        // A BOM before the opening `---` must not shift heading line numbers.
        let body = "---\ntype: note\n---\n\nlede\n\n# Heading\n\nbody\n";
        let with_bom = format!("\u{feff}{}", body);
        let plain = parse_document(body);
        let bommed = parse_document(&with_bom);
        assert_eq!(plain.tree.len(), 1);
        assert_eq!(bommed.tree.len(), 1);
        assert_eq!(bommed.tree[0].line, plain.tree[0].line);
        assert_eq!(bommed.tree[0].heading, "Heading");
        // Field order still recovered through the BOM.
        assert_eq!(
            crate::frontmatter::field_order(&with_bom),
            vec!["type".to_string()]
        );
    }
}
