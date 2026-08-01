//! Re-parse structural equivalence — the oracle that gates any rewrite.
//!
//! # Why the partition cannot be this oracle
//!
//! [`crate::check_partition`] is a **unary invariant of one document**:
//! `check_partition(src, block_spans(parse(src)))` never sees a second
//! document, so it cannot distinguish a faithful rewrite from an unfaithful
//! one. Measured, not argued: a blank-line rewrite was run over 2880 synthetic
//! documents, 167 of which it destroyed — a code block turned into a list, two
//! rendered blocks turned into invisible front matter, a link reference
//! definition deleted from the render — and the partition passed on **167 of
//! 167** outputs, as it did on all 1052 corpus outputs. What the partition does
//! contribute is a *precondition*: because it forbids unclaimed content, every
//! byte between two content-tight spans is whitespace, which is what makes "the
//! gap" definable at all (see [`crate::normalize`]).
//!
//! So a rewrite needs its own oracle, and this is it:
//! `structure(parse(src)) == structure(parse(rewrite(src)))`.
//!
//! # Why four signatures and not one
//!
//! [`Structure`] carries four renderings of the same parse, in increasing
//! strength:
//!
//! - **kinds** — a pre-order walk of block nodes emitting `"  "*depth + kind`.
//!   Node kinds, order, and nesting; nothing else.
//! - **rich** — the same walk emitting each node's full `NodeValue` `Debug`,
//!   which adds list `tight`, heading `setext`/`level`, `fence_offset`,
//!   `marker_offset`, table row/cell counts, and code-block literals.
//! - **html** — `comrak::format_html` equality, which is the only one of the
//!   three that reads inlines at all.
//! - **tables** — the one signature read from the **source**, not the tree.
//!   See below; the other three are jointly blind to a table's source shape.
//!
//! **kinds alone is not enough**, and that is demonstrated rather than assumed:
//! `tests/normalize.rs::kinds_and_html_agree_where_the_rich_signature_does_not`
//! holds a pair of documents whose kinds *and* HTML are equal while their
//! `marker_offset` differs. Conversely the walk skips inline subtrees entirely,
//! so `html` is what covers text: a link reference definition that comrak
//! starts consuming vanishes from the render, and only HTML equality sees the
//! text go.
//!
//! # Two normalizations, and why each is not a loosening
//!
//! - `NodeTaskItem::symbol_sourcepos` is a **position**, and every position
//!   shifts when a rewrite changes a line count. Left in, it produced 140 false
//!   positives across the corpus. Only `symbol` is kept.
//! - `FrontMatter` and `HtmlBlock` literals include the trailing blank lines
//!   that a blank-line rule exists to rewrite, so they are right-trimmed.
//!   `CodeBlock` literals are **not** trimmed — those are content, and a rule
//!   that ate them must fail here.
//!
//! Both are exemptions, so both are places this oracle could be quietly
//! widened. Neither touches a byte a rewrite is allowed to change silently:
//! the first drops a coordinate, and the second drops trailing whitespace from
//! the two node kinds whose literal is defined to absorb it.
//!
//! # The table signature, and the hole it closes
//!
//! The tree is **blind to a table's source shape**, and a census of table
//! padding found it: `| 1 | 2 |` and `| 1 | 2 |  |` inside a three-column table
//! parse to the same three `TableCell` nodes, render to the same three `<td>`s,
//! and carry no attribute that differs — comrak materializes a phantom cell over
//! the row's trailing pipe for the short row, and drops a long row's excess
//! cells from the tree while leaving their bytes on the line. So a rewrite that
//! gains or loses a cell on a ragged row passes **kinds, rich and html
//! together**. `tests/table_negative_controls.rs` holds that blindness open as
//! an assertion, in `the_tree_signatures_are_jointly_blind_to_a_synthesized_cell`.
//!
//! [`Structure::tables`] closes it by reading the source lines a table occupies:
//! per table, its column count and alignments, then per row the sequence of
//! **unescaped-pipe segments** trimmed of spaces, then the delimiter row's
//! alignment-marker pattern. That rejects
//!
//! - any change to a cell's content, as opposed to its surrounding spaces,
//! - a ragged row gaining or losing a cell,
//! - a change to a delimiter row's colons,
//!
//! and stays silent on the delimiter row's **dash count**, which is the one byte
//! sequence table padding is defined to change. Nothing else in this module
//! reads the source; this signature must, because the defect it covers exists
//! nowhere else.

use comrak::nodes::{AstNode, NodeValue};

use crate::print::block_kind;
use crate::span::LineIndex;
use crate::table::{line_content_range, split_unescaped_pipes};

/// Four renderings of one parse: block kinds with nesting, the same walk with
/// every node attribute, the rendered HTML, and each table's source shape.
/// Compare with [`Structure::diff`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Structure {
    /// Pre-order walk of block nodes: `"  "*depth + kind`.
    pub kinds: Vec<String>,
    /// The same walk, with each node's full `NodeValue` debug rendering.
    pub rich: Vec<String>,
    /// `comrak::format_html` output.
    pub html: String,
    /// Per table, the source shape of its rows and delimiter — the one
    /// signature the tree cannot supply. See the module docs.
    pub tables: Vec<String>,
}

/// How two [`Structure`]s differ, with the first differing entry in context so
/// a failure names the construct rather than the offset.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StructureDiff {
    pub kinds_same: bool,
    pub rich_same: bool,
    pub html_same: bool,
    pub tables_same: bool,
    /// Index of the first differing `rich` entry, when there is one.
    pub at: Option<usize>,
    /// The first differing entry before the rewrite, in context.
    pub before: String,
    /// The same window after the rewrite.
    pub after: String,
}

impl std::fmt::Display for StructureDiff {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "kinds_same={} rich_same={} html_same={} tables_same={}",
            self.kinds_same, self.rich_same, self.html_same, self.tables_same
        )?;
        if let Some(at) = self.at {
            write!(
                f,
                "; first difference at block node {at}: before {:?}, after {:?}",
                self.before, self.after
            )?;
        } else if !self.tables_same {
            write!(
                f,
                "; first table-shape difference: before {:?}, after {:?}",
                self.before, self.after
            )?;
        }
        Ok(())
    }
}

impl Structure {
    /// `None` when the two parses are structurally equivalent; otherwise which
    /// of the four comparisons failed, and where.
    pub fn diff(&self, other: &Structure) -> Option<StructureDiff> {
        let kinds_same = self.kinds == other.kinds;
        let rich_same = self.rich == other.rich;
        let html_same = self.html == other.html;
        let tables_same = self.tables == other.tables;
        if kinds_same && rich_same && html_same && tables_same {
            return None;
        }
        let window = |v: &[String], i: usize| {
            let lo = i.saturating_sub(1);
            let hi = (i + 2).min(v.len());
            v.get(lo..hi).unwrap_or(&[]).join(" | ")
        };
        let at = (0..self.rich.len().max(other.rich.len()))
            .find(|&i| self.rich.get(i) != other.rich.get(i));
        // When only the table signature differs there is no differing block
        // node to point at, so the context window comes from `tables` instead —
        // otherwise the one failure mode this signature exists for would report
        // no location at all.
        let (before, after) = match at {
            Some(i) => (window(&self.rich, i), window(&other.rich, i)),
            None if !tables_same => {
                let j = (0..self.tables.len().max(other.tables.len()))
                    .find(|&i| self.tables.get(i) != other.tables.get(i))
                    .unwrap_or(0);
                (window(&self.tables, j), window(&other.tables, j))
            }
            None => (String::new(), String::new()),
        };
        Some(StructureDiff {
            kinds_same,
            rich_same,
            html_same,
            tables_same,
            at,
            before,
            after,
        })
    }
}

/// Parse `source` under the shared comrak configuration and take its four
/// signatures.
pub fn structure_of(source: &str, opts: &mdstruct::Options) -> Structure {
    let arena = comrak::Arena::new();
    crate::parse_with(&arena, source, opts, |root| {
        let mut kinds = Vec::new();
        let mut rich = Vec::new();
        walk(root, 0, &mut kinds, &mut rich);
        let mut html = String::new();
        let options = crate::comrak_options(opts);
        comrak::format_html(root, &options, &mut html)
            .expect("formatting into a String cannot fail");
        let tables = table_shapes(root, source);
        Structure {
            kinds,
            rich,
            html,
            tables,
        }
    })
}

/// The source shape of every table in `root`, in document order.
///
/// Read from `source`, not from the tree, because the shape this covers has no
/// tree representation (see the module docs). Rows are addressed through their
/// own `sourcepos`, so the signature is stable under any rewrite that moves a
/// table without editing it — which is what keeps it usable as a gate for
/// [`crate::normalize`] as well as for [`crate::table`].
fn table_shapes<'a>(root: &'a AstNode<'a>, source: &str) -> Vec<String> {
    let idx = LineIndex::new(source);
    let line = |l: usize| line_content_range(&idx, l).map(|(s, e)| &source[s..e]);
    let mut out = Vec::new();
    for node in root.descendants() {
        let alignments = match &node.data.borrow().value {
            NodeValue::Table(t) => t.alignments.clone(),
            _ => continue,
        };
        out.push(format!(
            "table cols={} align={alignments:?}",
            alignments.len()
        ));
        let mut header_end: Option<usize> = None;
        for row in node.children() {
            let sp = row.data.borrow().sourcepos;
            if header_end.is_none() {
                header_end = Some(sp.end.line);
            }
            let segments: Vec<&str> = match line(sp.start.line) {
                Some(text) => split_unescaped_pipes(text)
                    .into_iter()
                    .map(|s| s.trim_matches(' '))
                    .collect(),
                None => vec!["<line out of range>"],
            };
            out.push(format!("  row {segments:?}"));
        }
        let delimiter = header_end.and_then(|l| line(l + 1));
        out.push(match delimiter {
            // Only the colons and the cell count, never the dash run: the dash
            // run is exactly what table padding rewrites.
            Some(text) => format!(
                "  delim {:?}",
                text.split('|')
                    .map(|seg| {
                        let t = seg.trim();
                        (
                            t.starts_with(':'),
                            t.len() > 1 && t.ends_with(':'),
                            t.is_empty(),
                        )
                    })
                    .collect::<Vec<_>>()
            ),
            None => "  delim <missing>".to_string(),
        });
    }
    out
}

/// Pre-order walk of the block skeleton. Inline subtrees are skipped whole —
/// a block-level rewrite never reaches inside one, and the HTML signature is
/// what covers inline text.
fn walk<'a>(node: &'a AstNode<'a>, depth: usize, kinds: &mut Vec<String>, rich: &mut Vec<String>) {
    for child in node.children() {
        {
            let data = child.data.borrow();
            // `FrontMatter` reports `block() == false` in comrak 0.53 despite
            // being a root child, so it has to be admitted by name or the whole
            // front-matter clause would be invisible to this oracle.
            if !data.value.block() && !matches!(data.value, NodeValue::FrontMatter(_)) {
                continue;
            }
            let pad = "  ".repeat(depth);
            kinds.push(format!("{pad}{}", block_kind(&data.value)));
            rich.push(format!("{pad}{}", normalized_debug(&data.value)));
        }
        walk(child, depth + 1, kinds, rich);
    }
}

/// A node's `Debug` with the two normalizations the module docs justify.
fn normalized_debug(value: &NodeValue) -> String {
    match value {
        NodeValue::FrontMatter(literal) => format!("FrontMatter({:?})", literal.trim_end()),
        NodeValue::HtmlBlock(html) => format!("HtmlBlock({:?})", html.literal.trim_end()),
        NodeValue::TaskItem(task) => format!("TaskItem({:?})", task.symbol),
        other => format!("{other:?}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(source: &str) -> Structure {
        structure_of(source, &mdstruct::Options::default())
    }

    #[test]
    fn equal_documents_are_equivalent() {
        assert_eq!(s("# H\n\npara\n").diff(&s("# H\n\npara\n")), None);
    }

    #[test]
    fn front_matter_appears_in_the_signature_despite_not_reporting_as_a_block() {
        let st = s("---\nk: v\n---\n\nbody\n");
        assert_eq!(st.kinds, vec!["frontmatter", "paragraph"]);
    }

    #[test]
    fn front_matter_and_html_block_literals_are_right_trimmed() {
        // The blank line after front matter lives in the FrontMatter literal,
        // so without the trim every intended gap change would read as a tree
        // change and the oracle would refuse its own normal form.
        assert_eq!(
            s("---\nk: v\n---\n\nbody\n").diff(&s("---\nk: v\n---\nbody\n")),
            None
        );
    }

    #[test]
    fn a_code_block_literal_is_not_trimmed() {
        // The counterpart: code-block content is content, and losing trailing
        // whitespace from it must be a diff.
        let diff = s("```\ncode   \n```\n")
            .diff(&s("```\ncode\n```\n"))
            .expect("a changed code literal must diff");
        assert!(!diff.rich_same);
    }

    #[test]
    fn a_task_items_symbol_position_is_not_structure() {
        // Same task list, one line further down: `symbol_sourcepos` shifts and
        // nothing structural has changed.
        assert_eq!(
            s("- [x] a\n")
                .rich
                .last()
                .map(|l| l.trim().to_string())
                .unwrap(),
            s("seed\n\n- [x] a\n")
                .rich
                .last()
                .map(|l| l.trim().to_string())
                .unwrap()
        );
    }
}
