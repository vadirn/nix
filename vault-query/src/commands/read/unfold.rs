//! Smart-unfold for `read` (Step 2, Backlog 5): given an addressed node, decide
//! per child whether to inline its (recursively unfolded) text or fold it to a
//! placeholder line, and build both the text sink and the JSON `content` from a
//! single walker so they cannot diverge (Decision 2).

use serde::Serialize;

use super::model::{node_tokens, range_lines, range_slice, Node};
use super::render::tree_line_string;

/// One child entry in an unfolded section's JSON output. `content` is present
/// only when the child was inlined; `folded` is true when it was folded.
#[derive(Serialize)]
pub(super) struct UnfoldChildJson {
    pub(super) address: String,
    pub(super) heading: String,
    pub(super) level: usize,
    pub(super) line: usize,
    pub(super) lines: usize,
    pub(super) tokens: usize,
    pub(super) folded: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) content: Option<String>,
}

#[derive(Serialize)]
pub(super) struct UnfoldJson {
    pub(super) path: String,
    pub(super) address: String,
    pub(super) heading: String,
    pub(super) slug: String,
    pub(super) level: usize,
    pub(super) line: usize,
    pub(super) lines: usize,
    pub(super) tokens: usize,
    pub(super) content: String,
    pub(super) children: Vec<UnfoldChildJson>,
}

/// Decide whether a child at `level_depth` levels below the addressed node is
/// inlined (recursed into) or folded to a placeholder.
///
/// `--full` forces inline. Otherwise inline requires both:
///   - within the depth budget (`level_depth < depth` when `depth` is set;
///     unlimited when `None`), and
///   - `child.tokens <= threshold`.
pub(super) fn should_inline(
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
    let within_depth = depth.is_none_or(|d| level_depth < d);
    within_depth && node_tokens(child, lines) <= threshold
}

/// Render the addressed node's own prose: the lines from `own_start` (the
/// heading line) through the line before its first child heading, or the node's
/// range end when it has no children.
pub(super) fn own_prose(n: &Node, lines: &[&str]) -> String {
    let own_end = n
        .children
        .first()
        .map_or(n.end, |c| c.start.saturating_sub(1));
    range_slice(lines, n.start, own_end).unwrap_or_default()
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
pub(super) fn unfold_content_string(
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
pub(super) fn unfold_child_json(
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
