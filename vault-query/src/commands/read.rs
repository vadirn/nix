use anyhow::Result;
use serde::Serialize;
use std::path::Path;
use std::str::FromStr;

use crate::{frontmatter, tokens, wikilink};

/// Output format for the read command (Decision 12).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ReadFormat {
    Text,
    Json,
}

impl FromStr for ReadFormat {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "text" => Ok(ReadFormat::Text),
            "json" => Ok(ReadFormat::Json),
            _ => Err(format!("unknown format: {} (expected text or json)", s)),
        }
    }
}

impl std::fmt::Display for ReadFormat {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ReadFormat::Text => write!(f, "text"),
            ReadFormat::Json => write!(f, "json"),
        }
    }
}

/// A heading node in the document tree.
#[derive(Debug, Clone)]
struct Node {
    address: String,
    heading: String,
    slug: String,
    level: usize,
    /// 1-based line number of the heading line.
    line: usize,
    /// Inclusive 1-based line range [start, end] of the node's content,
    /// from the heading line through the line before the next heading with
    /// `level <= self.level` (or EOF). Includes descendants.
    start: usize,
    end: usize,
    children: Vec<Node>,
}

/// The pre-heading / heading-less text region (`[0]`, label `(text)`).
#[derive(Debug, Clone)]
struct TextRegion {
    /// 1-based first line of the region.
    line: usize,
    start: usize,
    end: usize,
}

/// Parsed document: text region (if any) + heading tree, plus per-line slice
/// access for counting lines and tokens.
struct Document<'a> {
    lines: Vec<&'a str>,
    text: Option<TextRegion>,
    tree: Vec<Node>,
}

/// Lowercase number of body lines covered by an inclusive 1-based range.
fn range_lines(start: usize, end: usize) -> usize {
    if end >= start {
        end - start + 1
    } else {
        0
    }
}

/// Concatenate the inclusive 1-based line range back into a string slice for
/// token estimation. Lines were split on '\n', so rejoin with '\n'.
fn range_slice(lines: &[&str], start: usize, end: usize) -> String {
    if start == 0 || start > lines.len() {
        return String::new();
    }
    let s = start - 1;
    let e = end.min(lines.len());
    lines[s..e].join("\n")
}

/// Slugify a heading's text: drop wikilink syntax, strip backticks/`*`/`_`,
/// lowercase, map non-alphanumerics to `-`, collapse and trim `-`.
fn heading_slug(text: &str) -> String {
    let stripped = wikilink::strip(text);
    let mut s = String::with_capacity(stripped.len());
    for ch in stripped.chars() {
        match ch {
            '`' | '*' | '_' => {}
            _ => s.push(ch),
        }
    }
    let lower = s.to_lowercase();
    let mut out = String::with_capacity(lower.len());
    let mut prev_dash = false;
    for ch in lower.chars() {
        if ch.is_alphanumeric() {
            out.push(ch);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

/// Detect ATX headings and the text/heading structure of the body.
///
/// Scans the full file by 1-based line, skipping the leading frontmatter block
/// and fenced code blocks (``` and ~~~) so that `#` inside code is not a
/// heading. Returns the parsed document.
fn parse_document(content: &str) -> Document<'_> {
    let lines: Vec<&str> = content.lines().collect();
    let total = lines.len();

    // Determine the 1-based line index at which the body begins, i.e. the line
    // after the closing frontmatter `---`. If there is no frontmatter, the body
    // begins at line 1.
    let body_start = frontmatter_end_line(&lines);

    // First pass: collect heading (level, text, line), skipping fenced code.
    struct RawHeading {
        level: usize,
        text: String,
        line: usize,
    }
    let mut raw: Vec<RawHeading> = Vec::new();
    let mut fence: Option<char> = None; // Some('`') or Some('~') while inside a fence.

    for (idx, raw_line) in lines.iter().enumerate() {
        let lineno = idx + 1;
        if lineno < body_start {
            continue;
        }
        let trimmed = raw_line.trim_start();
        // Fence toggling: a line starting with ``` or ~~~ opens/closes a fence.
        if let Some(marker) = fence_marker(trimmed) {
            match fence {
                None => fence = Some(marker),
                Some(open) if open == marker => fence = None,
                Some(_) => {} // a different marker inside a fence is literal content
            }
            continue;
        }
        if fence.is_some() {
            continue;
        }
        if let Some((level, text)) = atx_heading(raw_line) {
            raw.push(RawHeading { level, text, line: lineno });
        }
    }

    // Text region: body content before the first heading (or whole body when
    // heading-less). Emit only when it holds non-whitespace.
    let text = {
        let region_start = body_start.max(1);
        let region_end = if let Some(first) = raw.first() {
            first.line.saturating_sub(1)
        } else {
            total
        };
        if region_end >= region_start
            && range_slice(&lines, region_start, region_end).trim().is_empty() == false
        {
            // Trim leading blank lines so the reported `line` points at the first
            // non-blank line, matching how a reader locates the lede.
            let mut first_line = region_start;
            while first_line <= region_end
                && lines.get(first_line - 1).map_or(true, |l| l.trim().is_empty())
            {
                first_line += 1;
            }
            Some(TextRegion {
                line: first_line,
                start: first_line,
                end: region_end,
            })
        } else {
            None
        }
    };

    // Build the tree with a level-stack. Compute each node's content range as a
    // second step once all heading lines are known.
    // Flat nodes first (without ranges/children), then assemble.
    let flats: Vec<FlatHeadingImpl> = raw
        .iter()
        .map(|h| FlatHeadingImpl {
            level: h.level,
            text: h.text.clone(),
            slug: heading_slug(&h.text),
            line: h.line,
        })
        .collect();

    // Content end for heading i = (line of next heading with level <= flats[i].level) - 1,
    // else `total`.
    let ends: Vec<usize> = (0..flats.len())
        .map(|i| {
            let mut end = total;
            for j in (i + 1)..flats.len() {
                if flats[j].level <= flats[i].level {
                    end = flats[j].line - 1;
                    break;
                }
            }
            end
        })
        .collect();

    // Assemble the tree. We use an index-stack into a flat Vec<Node> kept in a
    // recursive structure via a manual builder.
    let tree = build_tree(&flats, &ends);

    Document { lines, text, tree }
}

/// Build the heading tree from flat headings and their precomputed content ends.
/// Addresses: top-level children `1..N`; child = `parent + "." + (idx+1)`.
fn build_tree(
    flats: &[FlatHeadingImpl],
    ends: &[usize],
) -> Vec<Node> {
    // Stack of (level, address-prefix, child-count, index-path).
    // We construct nodes bottom-up is awkward; instead build with a pointer stack
    // into an arena of nodes addressed by path.
    let mut roots: Vec<Node> = Vec::new();
    // Stack holds the path of indices into the nested `children` vectors that
    // leads to the currently-open node at each level.
    let mut stack: Vec<usize> = Vec::new(); // indices; resolved against roots each push
    // We also track the level of each stacked node.
    let mut levels: Vec<usize> = Vec::new();

    for (i, h) in flats.iter().enumerate() {
        // Pop while top.level >= current level.
        while let Some(&top_level) = levels.last() {
            if top_level >= h.level {
                levels.pop();
                stack.pop();
            } else {
                break;
            }
        }

        let address = if stack.is_empty() {
            // Top-level: 1-based index among current roots.
            (roots.len() + 1).to_string()
        } else {
            let parent = node_at_path(&roots, &stack);
            format!("{}.{}", parent.address, parent.children.len() + 1)
        };

        let node = Node {
            address,
            heading: h.text.clone(),
            slug: h.slug.clone(),
            level: h.level,
            line: h.line,
            start: h.line,
            end: ends[i],
            children: Vec::new(),
        };

        // Insert into the tree at the current parent.
        let new_index = if stack.is_empty() {
            roots.push(node);
            roots.len() - 1
        } else {
            let parent = node_at_path_mut(&mut roots, &stack);
            parent.children.push(node);
            parent.children.len() - 1
        };

        stack.push(new_index);
        levels.push(h.level);
    }

    roots
}

/// Flattened heading the tree builder consumes: the heading's level, raw text,
/// precomputed slug, and 1-based heading line. Lifted to module scope so
/// `build_tree` can take a slice of it.
struct FlatHeadingImpl {
    level: usize,
    text: String,
    slug: String,
    line: usize,
}

/// Follow a path of child indices to a node (immutable).
fn node_at_path<'a>(roots: &'a [Node], path: &[usize]) -> &'a Node {
    let (first, rest) = path.split_first().expect("non-empty path");
    let mut node = &roots[*first];
    for &idx in rest {
        node = &node.children[idx];
    }
    node
}

/// Follow a path of child indices to a node (mutable).
fn node_at_path_mut<'a>(roots: &'a mut [Node], path: &[usize]) -> &'a mut Node {
    let (first, rest) = path.split_first().expect("non-empty path");
    let mut node = &mut roots[*first];
    for &idx in rest {
        node = &mut node.children[idx];
    }
    node
}

/// Return the 1-based line number where the body begins (line after the closing
/// frontmatter delimiter). Returns 1 when there is no frontmatter block.
fn frontmatter_end_line(lines: &[&str]) -> usize {
    if lines.first().map(|l| l.trim()) != Some("---") {
        return 1;
    }
    for (idx, line) in lines.iter().enumerate().skip(1) {
        if line.trim() == "---" {
            return idx + 2; // line after the closing `---` (1-based)
        }
    }
    // No closing delimiter: treat the whole file as body.
    1
}

/// If `trimmed` (already left-trimmed) opens or closes a fence, return its
/// marker char (backtick or tilde). A fence line is three or more of the same.
fn fence_marker(trimmed: &str) -> Option<char> {
    for marker in ['`', '~'] {
        if trimmed.starts_with(marker) {
            let count = trimmed.chars().take_while(|&c| c == marker).count();
            if count >= 3 {
                return Some(marker);
            }
        }
    }
    None
}

/// Parse an ATX heading line `^(#{1,6})\s+(.+)$`. Leading whitespace before `#`
/// is not allowed (matches CommonMark's indented-code rule only loosely, but is
/// adequate for vault files and avoids treating `   # comment` as a heading).
fn atx_heading(line: &str) -> Option<(usize, String)> {
    let bytes = line.as_bytes();
    let mut hashes = 0;
    while hashes < bytes.len() && bytes[hashes] == b'#' {
        hashes += 1;
    }
    if hashes == 0 || hashes > 6 {
        return None;
    }
    // Require at least one space/tab after the hashes, then non-empty text.
    let rest = &line[hashes..];
    if !rest.starts_with(' ') && !rest.starts_with('\t') {
        return None;
    }
    let text = rest.trim();
    if text.is_empty() {
        return None;
    }
    Some((hashes, text.to_string()))
}

// ---- Address resolution --------------------------------------------------

/// What an address resolved to.
enum Resolved<'a> {
    Text,
    Node(&'a Node),
}

/// Flatten the tree into a depth-first list of node references.
fn flatten<'a>(tree: &'a [Node], out: &mut Vec<&'a Node>) {
    for n in tree {
        out.push(n);
        flatten(&n.children, out);
    }
}

/// Resolve an address against a document. On failure prints to stderr and
/// exits with code 1 (unknown address or ambiguous slug).
fn resolve_address<'a>(doc: &'a Document, address: &str) -> Resolved<'a> {
    // `[0]` / `text` → the text region.
    if address == "0" || address.eq_ignore_ascii_case("text") {
        if doc.text.is_some() {
            return Resolved::Text;
        }
        eprintln!("No text region in this file (address '{}')", address);
        std::process::exit(1);
    }

    // Numeric dotted address: descend by 1-based index.
    if is_numeric_address(address) {
        let parts: Vec<usize> = address
            .split('.')
            .map(|p| p.parse::<usize>().unwrap())
            .collect();
        let mut level: &[Node] = &doc.tree;
        let mut current: Option<&Node> = None;
        for (depth, &idx) in parts.iter().enumerate() {
            if idx == 0 || idx > level.len() {
                eprintln!("Address '{}' out of range", address);
                std::process::exit(1);
            }
            let node = &level[idx - 1];
            current = Some(node);
            if depth + 1 < parts.len() {
                level = &node.children;
            }
        }
        return Resolved::Node(current.expect("numeric address yields a node"));
    }

    // Slug: collect nodes whose `heading_slug == needle`.
    let needle = heading_slug(address);
    let mut all: Vec<&Node> = Vec::new();
    flatten(&doc.tree, &mut all);
    let matches: Vec<&Node> = all.into_iter().filter(|n| n.slug == needle).collect();
    match matches.len() {
        0 => {
            eprintln!("No heading matches slug '{}'", needle);
            std::process::exit(1);
        }
        1 => Resolved::Node(matches[0]),
        _ => {
            // Ambiguous: list candidates to stderr (the `get` pattern).
            eprintln!("Ambiguous slug '{}'; candidates:", needle);
            for n in &matches {
                eprintln!("  {}  {}", n.address, n.heading);
            }
            std::process::exit(1);
        }
    }
}

/// True for `^\d+(\.\d+)*$`.
fn is_numeric_address(s: &str) -> bool {
    !s.is_empty()
        && s.split('.').all(|seg| !seg.is_empty() && seg.bytes().all(|b| b.is_ascii_digit()))
}

// ---- JSON shapes ---------------------------------------------------------

#[derive(Serialize)]
struct TextJson {
    address: String,
    label: String,
    line: usize,
    lines: usize,
    tokens: usize,
}

#[derive(Serialize)]
struct NodeJson {
    address: String,
    heading: String,
    level: usize,
    line: usize,
    lines: usize,
    tokens: usize,
    slug: String,
    children: Vec<NodeJson>,
}

#[derive(Serialize)]
struct OverviewJson {
    path: String,
    fields: Vec<String>,
    links: usize,
    text: Option<TextJson>,
    tree: Vec<NodeJson>,
}

fn node_to_json(n: &Node, lines: &[&str]) -> NodeJson {
    NodeJson {
        address: n.address.clone(),
        heading: n.heading.clone(),
        level: n.level,
        line: n.line,
        lines: range_lines(n.start, n.end),
        tokens: tokens::estimate_tokens(&range_slice(lines, n.start, n.end)),
        slug: n.slug.clone(),
        children: n.children.iter().map(|c| node_to_json(c, lines)).collect(),
    }
}

// ---- Entry point ---------------------------------------------------------

pub fn run(
    file: &Path,
    address: Option<&str>,
    depth: Option<usize>,
    full: bool,
    threshold: Option<usize>,
    format: ReadFormat,
) -> Result<()> {
    let _ = (depth, full, threshold); // Step 2 (smart-unfold) consumes these.

    let content = match std::fs::read_to_string(file) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Cannot read {}: {}", file.display(), e);
            std::process::exit(1);
        }
    };

    let doc = parse_document(&content);

    match address {
        None => emit_overview(file, &content, &doc, format),
        Some(addr) => emit_section(file, &doc, addr, format),
    }
}

/// Overview path (bare `read FILE`).
fn emit_overview(file: &Path, content: &str, doc: &Document, format: ReadFormat) -> Result<()> {
    let fm = frontmatter::parse(content).unwrap_or(None);
    let fields: Vec<String> = fm
        .as_ref()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();
    let link_count = wikilink::extract(content).len();

    if format == ReadFormat::Json {
        let text = doc.text.as_ref().map(|t| TextJson {
            address: "0".to_string(),
            label: "(text)".to_string(),
            line: t.line,
            lines: range_lines(t.start, t.end),
            tokens: tokens::estimate_tokens(&range_slice(&doc.lines, t.start, t.end)),
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
        let toks = tokens::estimate_tokens(&range_slice(&doc.lines, t.start, t.end));
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

/// Recursively print one overview tree line and its descendants.
fn print_tree_line(n: &Node, lines: &[&str]) {
    let marker = if n.children.is_empty() { ' ' } else { '+' };
    // Indent the heading column by depth (number of `.` segments).
    let depth = n.address.matches('.').count();
    let indent = "  ".repeat(depth);
    let lc = range_lines(n.start, n.end);
    let toks = tokens::estimate_tokens(&range_slice(lines, n.start, n.end));
    println!(
        "{} {}{:<6} {:<14} L{}   {} lines · ~{} tok",
        marker, indent, n.address, truncate_heading(&n.heading), n.line, lc, toks
    );
    for c in &n.children {
        print_tree_line(c, lines);
    }
}

/// Trim a heading for the tree column. Long headings are cut to keep the line
/// scannable; the address remains the stable handle.
fn truncate_heading(h: &str) -> String {
    let max = 30;
    if h.chars().count() <= max {
        h.to_string()
    } else {
        let prefix: String = h.chars().take(max - 1).collect();
        format!("{}…", prefix)
    }
}

/// With-address path. Step 1 resolves the node and prints a minimal section
/// dump; full smart-unfold is Step 2. Address resolution, `[0]`, and exit codes
/// are complete here.
fn emit_section(file: &Path, doc: &Document, address: &str, format: ReadFormat) -> Result<()> {
    match resolve_address(doc, address) {
        Resolved::Text => {
            let t = doc.text.as_ref().expect("text region present");
            let lines = range_lines(t.start, t.end);
            let toks = tokens::estimate_tokens(&range_slice(&doc.lines, t.start, t.end));
            let content = range_slice(&doc.lines, t.start, t.end);
            if format == ReadFormat::Json {
                let out = serde_json::json!({
                    "path": file.display().to_string(),
                    "address": "0",
                    "heading": "(text)",
                    "slug": "text",
                    "line": t.line,
                    "lines": lines,
                    "tokens": toks,
                    "content": content,
                });
                println!("{}", serde_json::to_string_pretty(&out)?);
            } else {
                println!("[0]  (text)   L{}   {} lines · ~{} tok", t.line, lines, toks);
                println!();
                print!("{}", content);
                if !content.ends_with('\n') {
                    println!();
                }
            }
        }
        Resolved::Node(n) => {
            let lines = range_lines(n.start, n.end);
            let toks = tokens::estimate_tokens(&range_slice(&doc.lines, n.start, n.end));
            let content = range_slice(&doc.lines, n.start, n.end);
            if format == ReadFormat::Json {
                let out = serde_json::json!({
                    "path": file.display().to_string(),
                    "address": n.address,
                    "heading": n.heading,
                    "slug": n.slug,
                    "line": n.line,
                    "lines": lines,
                    "tokens": toks,
                    "content": content,
                });
                println!("{}", serde_json::to_string_pretty(&out)?);
            } else {
                println!(
                    "{}  {}   L{}   {} lines · ~{} tok",
                    n.address, n.heading, n.line, lines, toks
                );
                println!();
                print!("{}", content);
                if !content.ends_with('\n') {
                    println!();
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "---\ntype: note\nslug: x\n---\n\nLede prose before any heading.\nSecond line of lede.\n\n# Direction\n\nDir body.\n\n## Sub one\n\nsub one body\n\n## Sub two\n\nsub two body\n\n# Glossary\n\ngloss body\n\n# Log & Notes\n\nfirst.\n\n# Log Notes\n\nsecond.\n";

    #[test]
    fn from_str_roundtrip() {
        assert_eq!(ReadFormat::from_str("text").unwrap(), ReadFormat::Text);
        assert_eq!(ReadFormat::from_str("json").unwrap(), ReadFormat::Json);
        assert_eq!(ReadFormat::from_str("JSON").unwrap(), ReadFormat::Json);
        assert!(ReadFormat::from_str("yaml").is_err());
        assert_eq!(ReadFormat::Text.to_string(), "text");
        assert_eq!(ReadFormat::Json.to_string(), "json");
    }

    #[test]
    fn slug_basic() {
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
    fn numeric_resolution() {
        let doc = parse_document(SAMPLE);
        match resolve_address_for_test(&doc, "1.2") {
            Some(TestResolved::Node(addr, heading)) => {
                assert_eq!(addr, "1.2");
                assert_eq!(heading, "Sub two");
            }
            other => panic!("expected node, got {:?}", other),
        }
    }

    #[test]
    fn slug_resolution() {
        let doc = parse_document(SAMPLE);
        match resolve_address_for_test(&doc, "glossary") {
            Some(TestResolved::Node(addr, _)) => assert_eq!(addr, "2"),
            other => panic!("expected node, got {:?}", other),
        }
    }

    #[test]
    fn text_resolution() {
        let doc = parse_document(SAMPLE);
        assert!(matches!(
            resolve_address_for_test(&doc, "0"),
            Some(TestResolved::Text)
        ));
        assert!(matches!(
            resolve_address_for_test(&doc, "text"),
            Some(TestResolved::Text)
        ));
    }

    #[test]
    fn ambiguous_slug_detected() {
        let doc = parse_document(SAMPLE);
        // "Log & Notes" and "Log Notes" both slugify to "log-notes".
        let needle = heading_slug("log-notes");
        let mut all = Vec::new();
        flatten(&doc.tree, &mut all);
        let matches: Vec<&Node> = all.into_iter().filter(|n| n.slug == needle).collect();
        assert_eq!(matches.len(), 2, "expected a slug collision in the fixture");
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

    // A test-only mirror of `resolve_address` that returns an Option instead of
    // calling `std::process::exit`, so unit tests can assert on resolution
    // without terminating the test process.
    #[derive(Debug)]
    enum TestResolved {
        Text,
        Node(String, String),
    }

    fn resolve_address_for_test(doc: &Document, address: &str) -> Option<TestResolved> {
        if address == "0" || address.eq_ignore_ascii_case("text") {
            return doc.text.as_ref().map(|_| TestResolved::Text);
        }
        if is_numeric_address(address) {
            let parts: Vec<usize> = address.split('.').map(|p| p.parse().unwrap()).collect();
            let mut level: &[Node] = &doc.tree;
            let mut current: Option<&Node> = None;
            for (depth, &idx) in parts.iter().enumerate() {
                if idx == 0 || idx > level.len() {
                    return None;
                }
                let node = &level[idx - 1];
                current = Some(node);
                if depth + 1 < parts.len() {
                    level = &node.children;
                }
            }
            return current.map(|n| TestResolved::Node(n.address.clone(), n.heading.clone()));
        }
        let needle = heading_slug(address);
        let mut all = Vec::new();
        flatten(&doc.tree, &mut all);
        let matches: Vec<&Node> = all.into_iter().filter(|n| n.slug == needle).collect();
        match matches.len() {
            1 => Some(TestResolved::Node(
                matches[0].address.clone(),
                matches[0].heading.clone(),
            )),
            _ => None,
        }
    }
}
