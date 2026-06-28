//! Overview rendering for `read`: the JSON shapes for the bare `read FILE`
//! overview and the text tree-line helpers shared with the unfold walker.

use serde::Serialize;

use super::model::{range_lines, range_slice, Node};
use crate::tokens;

#[derive(Serialize)]
pub(super) struct TextNodeJson {
    pub(super) address: String,
    pub(super) label: String,
    pub(super) line: usize,
    pub(super) lines: usize,
    pub(super) tokens: usize,
}

#[derive(Serialize)]
pub(super) struct NodeJson {
    pub(super) address: String,
    pub(super) heading: String,
    pub(super) level: usize,
    pub(super) line: usize,
    pub(super) lines: usize,
    pub(super) tokens: usize,
    pub(super) slug: String,
    pub(super) children: Vec<NodeJson>,
}

#[derive(Serialize)]
pub(super) struct OverviewJson {
    pub(super) path: String,
    pub(super) fields: Vec<String>,
    pub(super) links: usize,
    pub(super) text: Option<TextNodeJson>,
    pub(super) tree: Vec<NodeJson>,
}

pub(super) fn node_to_json(n: &Node, lines: &[&str]) -> NodeJson {
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
/// Shared by the overview renderer and the unfold folded-placeholder so that a
/// folded child reads identically to its overview line.
pub(super) fn tree_line_string(n: &Node, lines: &[&str]) -> String {
    let marker = if n.children.is_empty() { ' ' } else { '+' };
    // Indent the heading column by depth (number of `.` segments).
    let depth = n.address.matches('.').count();
    let indent = "  ".repeat(depth);
    let lc = range_lines(n.start, n.end);
    let toks = tokens::estimate_tokens(&range_slice(lines, n.start, n.end).unwrap_or_default());
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
pub(super) fn print_tree_line(n: &Node, lines: &[&str]) {
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
