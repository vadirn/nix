//! `read FILE [ADDRESS]`: render a Markdown file's heading tree (overview) or
//! smart-unfold one addressed section.
//!
//! The command is split across four private submodules — [`model`] (the heading
//! tree and its parser), [`resolve`] (address → node), [`unfold`] (the
//! inline/fold walker), and [`render`] (overview JSON shapes and tree lines) —
//! with [`run`] the only public item. Errors propagate as `Result`; `main` owns
//! the process exit code, so a read failure or unresolvable address exits 1
//! there rather than calling `process::exit` mid-stack.

mod model;
mod render;
mod resolve;
mod unfold;

use std::path::{Path, PathBuf};

use anyhow::Result;

use crate::output::TextJson;
use crate::{tokens, wikilink};

use model::{node_tokens, parse_document, range_lines, range_slice, Document};
use render::{node_to_json, print_tree_line, OverviewJson, TextNodeJson};
use resolve::resolve_address;
use unfold::{own_prose, unfold_child_json, unfold_content_string, UnfoldJson};

/// Resolve the path to read. A literal/absolute path that exists wins; if it
/// does not exist and a `vault_root` is configured, fall back to
/// `vault_root.join(file)`. When neither resolves, return the original so the
/// read error names what the caller asked for.
fn resolve_read_path(file: &Path, vault_root: Option<&Path>) -> PathBuf {
    if file.exists() {
        return file.to_path_buf();
    }
    if let Some(root) = vault_root {
        let joined = root.join(file);
        if joined.exists() {
            return joined;
        }
    }
    file.to_path_buf()
}

pub fn run(
    file: &Path,
    vault_root: Option<&Path>,
    address: Option<&str>,
    depth: Option<usize>,
    full: bool,
    threshold: Option<usize>,
    format: TextJson,
) -> Result<()> {
    // Honor any literal/absolute path that exists (track Decision 2: operate on
    // any `.md` path); fall back to vault-relative resolution so the bare
    // pointers consult emits (`read "20 cards/Foo.md"`) run from any cwd.
    let resolved = resolve_read_path(file, vault_root);
    let file = resolved.as_path();
    let content = std::fs::read_to_string(file)
        .map_err(|e| anyhow::anyhow!("Cannot read {}: {}", file.display(), e))?;

    let doc = parse_document(&content);

    // Default inline cutoff in estimated tokens. This is a tuning knob: the
    // track targets ~4k-token chunks, so revisit after first real use.
    let threshold = threshold.unwrap_or(2000);

    match address {
        None => emit_overview(file, &content, &doc, format),
        Some(addr) => emit_section(file, &doc, addr, depth, full, threshold, format),
    }
}

/// Overview path (bare `read FILE`).
fn emit_overview(file: &Path, content: &str, doc: &Document, format: TextJson) -> Result<()> {
    // `frontmatter::parse` returns a BTreeMap (alphabetized), which would
    // misrepresent the file's on-disk field order. Scan the raw frontmatter
    // block for top-level keys in source order instead.
    let fields: Vec<String> = crate::frontmatter::field_order(content);
    let link_count = wikilink::extract(content).len();

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
        let tree = doc.tree.iter().map(|n| node_to_json(n, &doc.lines)).collect();
        let out = OverviewJson {
            path: file.display().to_string(),
            fields,
            links: link_count,
            text,
            tree,
        };
        println!("{}", serde_json::to_string_pretty(&out)?);
        return Ok(());
    }

    // Text overview.
    println!("{}", file.display());
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
    println!("next: read FILE <addr> | properties FILE <path> | links FILE");
    Ok(())
}

/// With-address path: smart-unfold the addressed node (Backlog 5, Decision 8).
///
/// Text: print the node header, then its own prose, then for each direct child
/// either the inlined (recursively unfolded) text or a folded placeholder line
/// identical to the overview tree line. The text node (`[0]`) has no children,
/// so it prints its own prose uniformly.
///
/// JSON: `{ path, address, heading, slug, line, lines, tokens, content,
/// children:[{address, heading, line, lines, tokens, folded, content?}] }`.
fn emit_section(
    file: &Path,
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
            path: file.display().to_string(),
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
        print!("{}", unfold_content_string(n, &doc.lines, 0, depth, threshold, full));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::model::*;
    use super::render::tree_line_string;
    use super::resolve::{resolve, resolve_address, ResolveError};
    use super::unfold::*;
    use crate::output::TextJson;
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
    fn slug_basic() {
        use crate::slug::segment as heading_slug;
        assert_eq!(heading_slug("Direction"), "direction");
        assert_eq!(heading_slug("Sub one"), "sub-one");
        assert_eq!(heading_slug("Log & Notes"), "log-notes");
        assert_eq!(heading_slug("Log Notes"), "log-notes");
        assert_eq!(heading_slug("`code` *bold*"), "code-bold");
        assert_eq!(heading_slug("See [[A Note|Display]]"), "see-display");
        assert_eq!(heading_slug("1. Numbered"), "1-numbered");
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
        // An all-digit address that overflows usize must report out-of-range,
        // not panic on the parse.
        let doc = parse_document(SAMPLE);
        match resolve(&doc, "99999999999999999999") {
            Err(ResolveError::OutOfRange(addr)) => assert_eq!(addr, "99999999999999999999"),
            _ => panic!("expected OutOfRange, got a different result"),
        }
    }

    #[test]
    fn numeric_past_end_is_out_of_range() {
        let doc = parse_document(SAMPLE);
        assert!(matches!(resolve(&doc, "99"), Err(ResolveError::OutOfRange(_))));
    }

    #[test]
    fn no_slug_match_errors() {
        let doc = parse_document(SAMPLE);
        assert!(matches!(resolve(&doc, "nope"), Err(ResolveError::NoSlugMatch(_))));
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
        // resolve_address now returns a Result the caller propagates with `?`
        // (no process::exit), so the error path is unit-testable. The message
        // preserves the wording the command prints to stderr.
        let doc = parse_document(SAMPLE);
        let oob = resolve_address(&doc, "99").unwrap_err();
        assert!(oob.to_string().contains("out of range"), "got: {}", oob);
        let ambig = resolve_address(&doc, "log-notes").unwrap_err();
        let msg = ambig.to_string();
        assert!(msg.contains("Ambiguous"), "got: {}", msg);
        assert!(msg.contains("Log & Notes") && msg.contains("Log Notes"), "got: {}", msg);
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
    // child (above threshold), the large child carrying a grandchild. Used to
    // exercise the inline-vs-fold heuristic and the depth budget.
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
        // depth=1 admits level_depth 0 (the addressed node's direct children at
        // level_depth 1 fail since 1 < 1 is false)…
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
        assert!(!prose.contains("tiny."), "own prose must stop before first child: {}", prose);
    }

    #[test]
    fn folded_placeholder_matches_overview_line() {
        let doc = parse_document(UNFOLD);
        let large = &doc.tree[0].children[1];
        // The folded placeholder for a child equals that child's overview tree
        // line (the single-line form), so a reader can drill with the same address.
        let placeholder = tree_line_string(large, &doc.lines);
        assert!(placeholder.contains("1.2"), "placeholder: {}", placeholder);
        assert!(placeholder.contains("Large"), "placeholder: {}", placeholder);
        assert!(placeholder.trim_start().starts_with('+'), "Large has a child, marker '+': {}", placeholder);
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
        // A BOM before the opening `---` must not shift heading line numbers:
        // parsing with and without the BOM yields the same tree lines.
        let body = "---\ntype: note\n---\n\nlede\n\n# Heading\n\nbody\n";
        let with_bom = format!("\u{feff}{}", body);
        let plain = parse_document(body);
        let bommed = parse_document(&with_bom);
        assert_eq!(plain.tree.len(), 1);
        assert_eq!(bommed.tree.len(), 1);
        // Frontmatter skipped in both: heading on the same line, body starts
        // after the closing `---`.
        assert_eq!(bommed.tree[0].line, plain.tree[0].line);
        assert_eq!(bommed.tree[0].heading, "Heading");
        // Field order still recovered through the BOM.
        assert_eq!(crate::frontmatter::field_order(&with_bom), vec!["type".to_string()]);
    }
}
