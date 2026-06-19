use anyhow::Result;
use serde::Serialize;
use std::path::Path;

use crate::output::TextJson;
use crate::{tokens, wikilink};

/// A heading node in the document tree.
///
/// The pre-heading / heading-less text region is modelled as a synthetic node
/// (address `"0"`, slug `"text"`, heading `"(text)"`, `level` 0, empty
/// children) so resolver, overview, section, and JSON paths treat it like any
/// other node (Decision 4).
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

/// Parsed document: synthetic text node (if any) + heading tree, plus per-line
/// slice access for counting lines and tokens.
struct Document<'a> {
    lines: Vec<&'a str>,
    text: Option<Node>,
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
            Some(Node {
                address: "0".to_string(),
                heading: "(text)".to_string(),
                slug: "text".to_string(),
                level: 0,
                line: first_line,
                start: first_line,
                end: region_end,
                children: Vec::new(),
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
    // Strip a leading BOM so a BOM-prefixed `---` still opens the frontmatter
    // block, matching `frontmatter::parse`/`body` (which strip `\u{feff}`).
    let first = lines
        .first()
        .map(|l| l.trim_start_matches('\u{feff}').trim());
    if first != Some("---") {
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

/// Top-level frontmatter key names in their on-disk order.
///
/// `frontmatter::parse` returns a BTreeMap, losing source order; this scans the
/// raw block (the lines between the opening and closing `---`) for top-level
/// keys matching `^([^\s:][^:]*):`, so the overview `fields:` line reflects the
/// file rather than an alphabetization. Returns empty when there is no
/// frontmatter block. Indented lines (nested map entries, list items) are
/// skipped, as are blank and comment lines.
fn frontmatter_field_order(content: &str) -> Vec<String> {
    let content = content.trim_start_matches('\u{feff}'); // strip BOM
    let mut lines = content.lines();
    if lines.next().map(|l| l.trim()) != Some("---") {
        return Vec::new();
    }
    let mut fields = Vec::new();
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        // A top-level key starts in column 0 (no leading whitespace) with a
        // non-`:` name followed by `:`.
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

/// Why an address failed to resolve. Carries the data each variant needs to
/// reproduce the exact stderr message the `resolve_address` wrapper prints.
#[derive(Debug)]
enum ResolveError {
    /// `[0]`/`text` requested but the file has no text region. Holds the
    /// address as typed.
    NoTextRegion(String),
    /// Numeric address whose segment overflows `usize` or indexes past the
    /// tree. Holds the address as typed.
    OutOfRange(String),
    /// Slug matched no heading. Holds the slug.
    NoSlugMatch(String),
    /// Slug matched more than one heading. Holds the slug and the candidate
    /// `(address, heading)` pairs to list.
    Ambiguous(String, Vec<(String, String)>),
}

/// Flatten the tree into a depth-first list of node references.
fn flatten<'a>(tree: &'a [Node], out: &mut Vec<&'a Node>) {
    for n in tree {
        out.push(n);
        flatten(&n.children, out);
    }
}

/// Pure address resolution: all the descent/match logic, no process exit.
/// `resolve_address` wraps this to print stderr and exit; tests call it
/// directly so there is no parallel test mirror to drift (Decision 3).
fn resolve<'a>(doc: &'a Document, address: &str) -> Result<&'a Node, ResolveError> {
    // `[0]` / `text` → the synthetic text node.
    if address == "0" || address.eq_ignore_ascii_case("text") {
        return doc
            .text
            .as_ref()
            .ok_or_else(|| ResolveError::NoTextRegion(address.to_string()));
    }

    // Numeric dotted address: descend by 1-based index.
    if is_numeric_address(address) {
        let mut parts: Vec<usize> = Vec::new();
        for seg in address.split('.') {
            // An all-digit segment can still overflow `usize`; treat overflow
            // as out-of-range rather than panicking (mirrors properties.rs).
            match seg.parse::<usize>() {
                Ok(n) => parts.push(n),
                Err(_) => return Err(ResolveError::OutOfRange(address.to_string())),
            }
        }
        let mut level: &[Node] = &doc.tree;
        let mut current: Option<&Node> = None;
        for (depth, &idx) in parts.iter().enumerate() {
            if idx == 0 || idx > level.len() {
                return Err(ResolveError::OutOfRange(address.to_string()));
            }
            let node = &level[idx - 1];
            current = Some(node);
            if depth + 1 < parts.len() {
                level = &node.children;
            }
        }
        return Ok(current.expect("numeric address yields a node"));
    }

    // Slug: collect nodes whose `heading_slug == needle`.
    let needle = heading_slug(address);
    let mut all: Vec<&Node> = Vec::new();
    flatten(&doc.tree, &mut all);
    let matches: Vec<&Node> = all.into_iter().filter(|n| n.slug == needle).collect();
    match matches.len() {
        0 => Err(ResolveError::NoSlugMatch(needle)),
        1 => Ok(matches[0]),
        _ => Err(ResolveError::Ambiguous(
            needle,
            matches
                .iter()
                .map(|n| (n.address.clone(), n.heading.clone()))
                .collect(),
        )),
    }
}

/// Resolve an address against a document. On failure prints to stderr and
/// exits with code 1 (unknown address or ambiguous slug). Thin wrapper over
/// the pure `resolve`.
fn resolve_address<'a>(doc: &'a Document, address: &str) -> &'a Node {
    match resolve(doc, address) {
        Ok(n) => n,
        Err(ResolveError::NoTextRegion(addr)) => {
            eprintln!("No text region in this file (address '{}')", addr);
            std::process::exit(1);
        }
        Err(ResolveError::OutOfRange(addr)) => {
            eprintln!("Address '{}' out of range", addr);
            std::process::exit(1);
        }
        Err(ResolveError::NoSlugMatch(needle)) => {
            eprintln!("No heading matches slug '{}'", needle);
            std::process::exit(1);
        }
        Err(ResolveError::Ambiguous(needle, candidates)) => {
            eprintln!("Ambiguous slug '{}'; candidates:", needle);
            for (addr, heading) in &candidates {
                eprintln!("  {}  {}", addr, heading);
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
struct TextNodeJson {
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
    text: Option<TextNodeJson>,
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

/// One child entry in an unfolded section's JSON output. `content` is present
/// only when the child was inlined; `folded` is true when it was folded.
#[derive(Serialize)]
struct UnfoldChildJson {
    address: String,
    heading: String,
    level: usize,
    line: usize,
    lines: usize,
    tokens: usize,
    folded: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
}

#[derive(Serialize)]
struct UnfoldJson {
    path: String,
    address: String,
    heading: String,
    slug: String,
    level: usize,
    line: usize,
    lines: usize,
    tokens: usize,
    content: String,
    children: Vec<UnfoldChildJson>,
}

// ---- Smart-unfold (Step 2, Backlog 5) ------------------------------------

/// Estimated tokens covered by a node's full range (heading through descendants).
fn node_tokens(n: &Node, lines: &[&str]) -> usize {
    tokens::estimate_tokens(&range_slice(lines, n.start, n.end))
}

/// Decide whether a child at `level_depth` levels below the addressed node is
/// inlined (recursed into) or folded to a placeholder.
///
/// `--full` forces inline. Otherwise inline requires both:
///   - within the depth budget (`level_depth < depth` when `depth` is set;
///     unlimited when `None`), and
///   - `child.tokens <= threshold`.
fn should_inline(
    child: &Node,
    lines: &[&str],
    level_depth: usize,
    depth: Option<usize>,
    threshold: usize,
    full: bool,
) -> bool {
    if full {
        return true;
    }
    let within_depth = depth.map_or(true, |d| level_depth < d);
    within_depth && node_tokens(child, lines) <= threshold
}

/// Render the addressed node's own prose: the lines from `own_start` (the
/// heading line) through the line before its first child heading, or the node's
/// range end when it has no children.
fn own_prose(n: &Node, lines: &[&str]) -> String {
    let own_end = n
        .children
        .first()
        .map_or(n.end, |c| c.start.saturating_sub(1));
    range_slice(lines, n.start, own_end)
}

/// The single unfold walker. Writes a node's own prose, then for each child
/// either the recursively-unfolded text (inline) or a folded placeholder line
/// identical to the overview tree line. Both the text sink (`emit_section`
/// prints the returned string) and the JSON `content` string come from here,
/// so they cannot diverge (Decision 2).
///
/// `level_depth` counts levels below the addressed node (0 at the addressed
/// node itself). Each emitted segment is newline-terminated: own prose gets a
/// trailing newline when non-empty and lacking one, and each folded placeholder
/// is its own line.
fn unfold_content_string(
    n: &Node,
    lines: &[&str],
    level_depth: usize,
    depth: Option<usize>,
    threshold: usize,
    full: bool,
) -> String {
    let mut out = String::new();
    write_unfold(n, lines, level_depth, depth, threshold, full, &mut out)
        .expect("writing to String never fails");
    out
}

/// Recursive core of the unfold walker, writing into any `fmt::Write` sink.
fn write_unfold(
    n: &Node,
    lines: &[&str],
    level_depth: usize,
    depth: Option<usize>,
    threshold: usize,
    full: bool,
    out: &mut dyn std::fmt::Write,
) -> std::fmt::Result {
    let prose = own_prose(n, lines);
    write!(out, "{}", prose)?;
    if !prose.is_empty() && !prose.ends_with('\n') {
        writeln!(out)?;
    }
    for child in &n.children {
        if should_inline(child, lines, level_depth, depth, threshold, full) {
            write_unfold(child, lines, level_depth + 1, depth, threshold, full, out)?;
        } else {
            // Folded placeholder identical to the overview tree line so the
            // reader can drill further with the same address grammar.
            writeln!(out, "{}", tree_line_string(child, lines))?;
        }
    }
    Ok(())
}

/// Recursively build a child's unfold JSON. When inlined, `content` holds the
/// child's own prose plus its (recursively unfolded) descendants, and `folded`
/// is false; when folded, `content` is omitted and `folded` is true.
fn unfold_child_json(
    n: &Node,
    lines: &[&str],
    level_depth: usize,
    depth: Option<usize>,
    threshold: usize,
    full: bool,
) -> UnfoldChildJson {
    let inline = should_inline(n, lines, level_depth, depth, threshold, full);
    let content = if inline {
        Some(unfold_content_string(n, lines, level_depth, depth, threshold, full))
    } else {
        None
    };
    UnfoldChildJson {
        address: n.address.clone(),
        heading: n.heading.clone(),
        level: n.level,
        line: n.line,
        lines: range_lines(n.start, n.end),
        tokens: node_tokens(n, lines),
        folded: !inline,
        content,
    }
}

// ---- Entry point ---------------------------------------------------------

pub fn run(
    file: &Path,
    address: Option<&str>,
    depth: Option<usize>,
    full: bool,
    threshold: Option<usize>,
    format: TextJson,
) -> Result<()> {
    let content = match std::fs::read_to_string(file) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Cannot read {}: {}", file.display(), e);
            std::process::exit(1);
        }
    };

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
    let fields: Vec<String> = frontmatter_field_order(content);
    let link_count = wikilink::extract(content).len();

    if format == TextJson::Json {
        let text = doc.text.as_ref().map(|t| TextNodeJson {
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

/// Format a single overview tree line (no trailing newline, no descendants).
/// Shared by the overview renderer and the unfold folded-placeholder so that a
/// folded child reads identically to its overview line.
fn tree_line_string(n: &Node, lines: &[&str]) -> String {
    let marker = if n.children.is_empty() { ' ' } else { '+' };
    // Indent the heading column by depth (number of `.` segments).
    let depth = n.address.matches('.').count();
    let indent = "  ".repeat(depth);
    let lc = range_lines(n.start, n.end);
    let toks = tokens::estimate_tokens(&range_slice(lines, n.start, n.end));
    format!(
        "{} {}{:<6} {:<14} L{}   {} lines · ~{} tok",
        marker, indent, n.address, truncate_heading(&n.heading), n.line, lc, toks
    )
}

/// Print one tree line and no descendants (folded placeholder in unfold output).
fn print_tree_line_single(n: &Node, lines: &[&str]) {
    println!("{}", tree_line_string(n, lines));
}

/// Recursively print one overview tree line and its descendants.
fn print_tree_line(n: &Node, lines: &[&str]) {
    print_tree_line_single(n, lines);
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
    let n = resolve_address(doc, address);
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
    use super::*;
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
    fn ambiguous_slug_detected() {
        let doc = parse_document(SAMPLE);
        // "Log & Notes" and "Log Notes" both slugify to "log-notes".
        let needle = heading_slug("log-notes");
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
    fn frontmatter_field_order_follows_source() {
        // Source order differs from alphabetical (type, created, aliases).
        let content = "---\ntype: note\ncreated: 2026-01-01\naliases:\n  - alt\n---\n\nbody\n";
        assert_eq!(
            frontmatter_field_order(content),
            vec!["type".to_string(), "created".to_string(), "aliases".to_string()]
        );
    }

    #[test]
    fn frontmatter_field_order_empty_without_block() {
        assert!(frontmatter_field_order("# Heading\n\nbody\n").is_empty());
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
        assert_eq!(frontmatter_field_order(&with_bom), vec!["type".to_string()]);
    }
}
