//! Overview rendering: the JSON shapes for the bare overview and the text
//! tree-line helpers shared with the unfold walker.

use serde::Serialize;

use crate::model::{Node, range_lines, range_slice};
use crate::tokens;

#[derive(Serialize)]
pub(crate) struct TextNodeJson {
    pub(crate) address: String,
    pub(crate) label: String,
    pub(crate) line: usize,
    pub(crate) lines: usize,
    pub(crate) tokens: usize,
}

#[derive(Serialize)]
pub(crate) struct NodeJson {
    pub(crate) address: String,
    pub(crate) heading: String,
    pub(crate) level: usize,
    pub(crate) line: usize,
    pub(crate) lines: usize,
    pub(crate) tokens: usize,
    pub(crate) slug: String,
    pub(crate) children: Vec<NodeJson>,
}

#[derive(Serialize)]
pub(crate) struct OverviewJson {
    pub(crate) path: String,
    pub(crate) fields: Vec<String>,
    pub(crate) links: usize,
    pub(crate) text: Option<TextNodeJson>,
    pub(crate) tree: Vec<NodeJson>,
}

pub(crate) fn node_to_json(n: &Node, lines: &[&str]) -> NodeJson {
    NodeJson {
        address: n.address.clone(),
        heading: n.heading.clone(),
        level: n.level,
        line: n.line,
        lines: range_lines(n.start, n.end),
        tokens: tokens::estimate_tokens(&range_slice(lines, n.start, n.end).unwrap_or_default()),
        slug: n.slug.clone(),
        children: n.children.iter().map(|c| node_to_json(c, lines)).collect(),
    }
}

/// Format a single overview tree line (no trailing newline, no descendants).
/// Shared by the overview renderer and the unfold folded-placeholder so a folded
/// child reads identically to its overview line.
pub(crate) fn tree_line_string(n: &Node, lines: &[&str]) -> String {
    let marker = if n.children.is_empty() { ' ' } else { '+' };
    // Indent the heading column by depth (number of `.` segments).
    let depth = n.address.matches('.').count();
    let indent = "  ".repeat(depth);
    let lc = range_lines(n.start, n.end);
    let toks = tokens::estimate_tokens(&range_slice(lines, n.start, n.end).unwrap_or_default());
    format!(
        "{} {}{:<6} {:<14} L{}   {} lines · ~{} tok",
        marker,
        indent,
        n.address,
        truncate_heading(&n.heading),
        n.line,
        lc,
        toks
    )
}

/// Print one tree line and no descendants (folded placeholder in unfold output).
fn print_tree_line_single(n: &Node, lines: &[&str]) {
    println!("{}", tree_line_string(n, lines));
}

/// Recursively print one overview tree line and its descendants.
pub(crate) fn print_tree_line(n: &Node, lines: &[&str]) {
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
