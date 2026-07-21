//! Document model: the heading tree, its parser, and the per-line range
//! arithmetic the renderers and resolver share.
//!
//! The pre-heading / heading-less text region is modelled as a synthetic node
//! (address `"0"`, slug `"text"`, heading `"(text)"`, `level` 0, empty children)
//! so resolver, overview, section, and JSON paths treat it like any other node.

use crate::facet::HeadingRule;
use crate::tokens;

/// A heading node in the document tree.
#[derive(Debug, Clone)]
pub(crate) struct Node {
    pub(crate) address: String,
    pub(crate) heading: String,
    pub(crate) slug: String,
    pub(crate) level: usize,
    /// 1-based line number of the heading line.
    pub(crate) line: usize,
    /// Inclusive 1-based line range [start, end] of the node's content, from the
    /// heading line through the line before the next heading with
    /// `level <= self.level` (or EOF). Includes descendants.
    pub(crate) start: usize,
    pub(crate) end: usize,
    pub(crate) children: Vec<Node>,
}

/// Parsed document: synthetic text node (if any) + heading tree, plus per-line
/// slice access for counting lines and tokens.
pub(crate) struct Document<'a> {
    pub(crate) lines: Vec<&'a str>,
    pub(crate) text: Option<Node>,
    pub(crate) tree: Vec<Node>,
}

/// Number of body lines covered by an inclusive 1-based range.
pub(crate) fn range_lines(start: usize, end: usize) -> usize {
    if end >= start { end - start + 1 } else { 0 }
}

/// Concatenate the inclusive 1-based line range back into a string slice for
/// token estimation. Lines were split by [`crate::facet::lines`] (line endings
/// dropped), so rejoin with '\n'. Returns `None` for a range that does not name
/// real body lines (start before line 1, start past EOF, or an inverted
/// end < start).
pub(crate) fn range_slice(lines: &[&str], start: usize, end: usize) -> Option<String> {
    if start == 0 || start > lines.len() || end < start {
        return None;
    }
    let s = start - 1;
    let e = end.min(lines.len());
    Some(lines[s..e].join("\n"))
}

/// Estimated tokens covered by a node's full range (heading through descendants).
pub(crate) fn node_tokens(n: &Node, lines: &[&str]) -> usize {
    tokens::estimate_tokens(&range_slice(lines, n.start, n.end).unwrap_or_default())
}

/// Parse with the general CommonMark heading rule (used by tests).
#[cfg(test)]
pub(crate) fn parse_document(content: &str) -> Document<'_> {
    parse_document_with(content, HeadingRule::CommonMark)
}

/// Detect headings and the text/heading structure of the body under `rule`.
///
/// Heading detection comes from the mdstruct locator facet — comrak excludes a
/// `#` inside a code fence or the frontmatter block — with the `body_start`
/// guard dropping any heading before the body.
pub(crate) fn parse_document_with(content: &str, rule: HeadingRule) -> Document<'_> {
    let lines: Vec<&str> = crate::facet::lines(content);
    let total = lines.len();

    // 1-based line at which the body begins (the line after the closing
    // frontmatter `---`, or line 1 when there is no frontmatter).
    let body_start = crate::frontmatter::body_start_line(content);

    let raw: Vec<crate::facet::BodyHeading> = crate::facet::body_headings(content, rule)
        .into_iter()
        .filter(|h| h.line >= body_start)
        .collect();

    // Text region: body content before the first heading (or the whole body when
    // heading-less). Emit only when it holds non-whitespace.
    let text = {
        let region_start = body_start.max(1);
        let region_end = if let Some(first) = raw.first() {
            first.line.saturating_sub(1)
        } else {
            total
        };
        if region_end >= region_start
            && range_slice(&lines, region_start, region_end).is_some_and(|s| !s.trim().is_empty())
        {
            // Trim leading blank lines so `line` points at the first non-blank.
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

    let flats: Vec<FlatHeading> = raw
        .iter()
        .map(|h| FlatHeading {
            level: h.level,
            text: h.text.clone(),
            slug: crate::slug::segment(&h.text),
            line: h.line,
        })
        .collect();

    // Content end for heading i = (line of next heading with level <= flats[i].level) - 1, else total.
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

    let tree = build_tree(&flats, &ends);

    Document { lines, text, tree }
}

/// Build the heading tree from flat headings and their precomputed content ends.
/// Addresses: top-level children `1..N`; child = `parent + "." + (idx+1)`.
fn build_tree(flats: &[FlatHeading], ends: &[usize]) -> Vec<Node> {
    let mut roots: Vec<Node> = Vec::new();
    // Path of indices into the nested `children` vectors to the open node at each
    // level, and the level of each stacked node.
    let mut stack: Vec<usize> = Vec::new();
    let mut levels: Vec<usize> = Vec::new();

    for (i, h) in flats.iter().enumerate() {
        while let Some(&top_level) = levels.last() {
            if top_level >= h.level {
                levels.pop();
                stack.pop();
            } else {
                break;
            }
        }

        let address = if stack.is_empty() {
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
/// precomputed slug, and 1-based heading line.
struct FlatHeading {
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
pub(crate) fn flatten<'a>(tree: &'a [Node], out: &mut Vec<&'a Node>) {
    for n in tree {
        out.push(n);
        flatten(&n.children, out);
    }
}

/// True for `^\d+(\.\d+)*$`.
pub(crate) fn is_numeric_address(s: &str) -> bool {
    !s.is_empty()
        && s.split('.').all(|seg| !seg.is_empty() && seg.bytes().all(|b| b.is_ascii_digit()))
}
