//! Document model for `read`: the heading tree, its parser, and the per-line
//! range arithmetic the renderers and resolver share.
//!
//! The pre-heading / heading-less text region is modelled as a synthetic node
//! (address `"0"`, slug `"text"`, heading `"(text)"`, `level` 0, empty
//! children) so resolver, overview, section, and JSON paths treat it like any
//! other node (Decision 4).

use crate::tokens;

/// A heading node in the document tree.
#[derive(Debug, Clone)]
pub(super) struct Node {
    pub(super) address: String,
    pub(super) heading: String,
    pub(super) slug: String,
    pub(super) level: usize,
    /// 1-based line number of the heading line.
    pub(super) line: usize,
    /// Inclusive 1-based line range [start, end] of the node's content,
    /// from the heading line through the line before the next heading with
    /// `level <= self.level` (or EOF). Includes descendants.
    pub(super) start: usize,
    pub(super) end: usize,
    pub(super) children: Vec<Node>,
}

/// Parsed document: synthetic text node (if any) + heading tree, plus per-line
/// slice access for counting lines and tokens.
pub(super) struct Document<'a> {
    pub(super) lines: Vec<&'a str>,
    pub(super) text: Option<Node>,
    pub(super) tree: Vec<Node>,
}

/// Number of body lines covered by an inclusive 1-based range.
pub(super) fn range_lines(start: usize, end: usize) -> usize {
    if end >= start {
        end - start + 1
    } else {
        0
    }
}

/// Concatenate the inclusive 1-based line range back into a string slice for
/// token estimation. Lines were split on '\n', so rejoin with '\n'. Returns
/// `None` for a range that does not name real body lines (start before line 1,
/// start past EOF, or an inverted end < start), so callers turn an out-of-range
/// request into an explicit empty/zero rather than indexing past the slice.
pub(super) fn range_slice(lines: &[&str], start: usize, end: usize) -> Option<String> {
    if start == 0 || start > lines.len() || end < start {
        return None;
    }
    let s = start - 1;
    let e = end.min(lines.len());
    Some(lines[s..e].join("\n"))
}

/// Estimated tokens covered by a node's full range (heading through descendants).
pub(super) fn node_tokens(n: &Node, lines: &[&str]) -> usize {
    tokens::estimate_tokens(&range_slice(lines, n.start, n.end).unwrap_or_default())
}

/// Detect ATX headings and the text/heading structure of the body.
///
/// Scans the full file by 1-based line, skipping the leading frontmatter block
/// and fenced code blocks (``` and ~~~) so that `#` inside code is not a
/// heading. Returns the parsed document.
pub(super) fn parse_document(content: &str) -> Document<'_> {
    let lines: Vec<&str> = content.lines().collect();
    let total = lines.len();

    // Determine the 1-based line index at which the body begins, i.e. the line
    // after the closing frontmatter `---`. If there is no frontmatter, the body
    // begins at line 1.
    let body_start = crate::frontmatter::body_start_line(content);

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
        if let Some(marker) = crate::markdown::fence_marker(trimmed) {
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
        if let Some((level, text)) = crate::markdown::atx_heading(raw_line) {
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
            && range_slice(&lines, region_start, region_end)
                .is_some_and(|s| !s.trim().is_empty())
        {
            // Trim leading blank lines so the reported `line` points at the first
            // non-blank line, matching how a reader locates the lede.
            let mut first_line = region_start;
            while first_line <= region_end
                && lines.get(first_line - 1).is_none_or(|l| l.trim().is_empty())
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
            slug: crate::slug::segment(&h.text),
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
                    end = flats[j].line.saturating_sub(1);
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
fn build_tree(flats: &[FlatHeadingImpl], ends: &[usize]) -> Vec<Node> {
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

/// Flatten the tree into a depth-first list of node references.
pub(super) fn flatten<'a>(tree: &'a [Node], out: &mut Vec<&'a Node>) {
    for n in tree {
        out.push(n);
        flatten(&n.children, out);
    }
}

/// True for `^\d+(\.\d+)*$`.
pub(super) fn is_numeric_address(s: &str) -> bool {
    !s.is_empty()
        && s.split('.').all(|seg| !seg.is_empty() && seg.bytes().all(|b| b.is_ascii_digit()))
}
