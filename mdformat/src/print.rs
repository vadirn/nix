//! The block-level passthrough printer and the partition oracle that gates it.
//!
//! # What the printer is
//!
//! [`reassemble`] emits, in source order, the original bytes of every
//! top-level block span plus the bytes between spans. It normalizes nothing,
//! because it never asks comrak to render: comrak's own printer (`cm.rs`)
//! reads `sourcepos` in zero places, so a sourcepos-driven passthrough
//! inherits none of comrak's rewrites. Constructs the parser does not model —
//! footnote definitions (`extension.footnote` is deliberately off), `$…$` and
//! `$$…$$` math, `> [!Note]` callouts, `#tags`, `[[wikilinks]]` — survive as
//! the bytes they are, inside whatever paragraph or block quote claims them.
//!
//! # Why reassembly is not the oracle
//!
//! [`reassemble`] keeps a cursor: for each block it emits the gap before the
//! block, then the block, then advances. That emits bytes `0..len` exactly
//! once in source order **whatever the spans are** — the gap slice absorbs
//! any boundary error, so `reassemble(src, blocks) == src` holds for a span
//! set shortened by one byte per block just as it does for the true one. An
//! earlier scan of this vault made exactly that mistake and had to discard the
//! result. `tests/partition.rs::reassembly_alone_misses_what_the_partition_catches`
//! keeps the trap documented as a live assertion.
//!
//! [`crate::Partition`] therefore does not compute the comparison at all. It
//! used to, as a second conjunct of `passed()`, which made a verdict resting
//! wholly on [`check_partition`] read as though it rested on two things. The
//! conjunct could not fail, so removing it changed no file's verdict; what it
//! changed is that no reader has to work out that it never could.
//!
//! The key check is [`check_partition`]: every non-whitespace byte of
//! the input lies in **exactly one** block span, no two spans overlap, and no
//! span reaches past the end of the input. That is the property a *later*
//! milestone needs. When a formatter rewrites one block — table padding, list
//! marker unification — it splices the replacement over that block's range and
//! leaves every other byte alone; only a partition guarantees the splice
//! neither drops nor duplicates the rest of the file.
//!
//! # Scope: one span per top-level block
//!
//! [`block_spans`] emits exactly one span per child of the document root, and
//! never a second span for anything nested inside one — a list's span already
//! covers its items, so claiming the items too would be an overlap. It does
//! read the *extent* of nested blocks, because comrak's container sourcepos
//! can truncate (see below), but it never reads inlines, whose spans carry
//! known defects a block-level printer has no reason to inherit: an inline in
//! a table cell shifts one byte left per preceding `\|` in that cell, because
//! comrak unescapes before inline parsing.
//!
//! # Two things comrak's block sourcepos will not give you
//!
//! **A container's end can fall short of its content.** An indented code block
//! inside a list item truncates the spans of everything containing it: in
//! `30 notes/Goals.md` the list at line 74 reports `74:1-83:9`, ending on the
//! *ninth column* of a line whose content runs to line 86, and the offending
//! item's own code block reports the empty range `76:9-76:9`. Taking the
//! container's sourcepos at face value leaves 179 bytes of real content in no
//! span at all. [`block_spans`] therefore expands each top-level span to the
//! union of its own range and the ranges of its **block** descendants, which
//! is what `mdstruct::core::build::expand` does for the same reason. The union
//! recovers those bytes because the last item's spans are correct even when
//! its siblings' are not.
//!
//! That condition is also the repair's limit: it needs *some* later block
//! descendant to report a correct end. Put the indented code block in the LAST
//! list item and follow the list with a top-level block, and comrak reports
//! that code block as an empty range too — no correct end is left to borrow,
//! and the union recovers nothing.
//! `tests/negative_controls.rs::an_indented_code_block_in_the_last_list_item_leaves_its_content_uncovered`
//! holds that shape open as an asserted failure, with the same list at EOF as
//! its passing control. Corpus exposure is zero: comrak finds 8 indented code
//! blocks across the 1052-file vault — 7 in `30 notes/Goals.md`, 1 in
//! `30 notes/Nix, nix-shell.md` — and every one has a later sibling to borrow
//! from.
//!
//! **Link reference definitions vanish.** comrak consumes them without
//! emitting a node, so their bytes belong to no span:
//! `"[a]: https://x.io\n\nbody\n"` yields a single paragraph covering `body`
//! alone. This is not theoretical for a vault that keeps bibliographies as
//! footnote definitions — `[^1]: https://x.io` is a *valid* link reference
//! definition (label `^1`, destination `https://x.io`) and is deleted, while
//! `[^1]: Author, Title, 2020` is not one and survives as a paragraph. Four
//! operative vault files depend on the difference. [`block_spans`] models the
//! dropped lines as `linkReferenceDefinition` blocks so the printer emits
//! them; the recognition is line-exact and shape-checked
//! ([`opens_link_reference_definition`]), never a blanket tolerance for
//! unclaimed bytes, so the injection the oracle exists to catch still fails.
//! `mdstruct` covers the same gaps in `fill_gaps`, but with a synthetic node
//! for *any* unclaimed content, which is the tolerance this deliberately
//! avoids.

use comrak::nodes::{AstNode, NodeValue, Sourcepos};

use crate::bom::BOM;
use crate::span::{LineIndex, PosError};

/// A top-level block and the byte range of source it claims.
///
/// `sourcepos` is `None` for the two spans not backed by a comrak node: a
/// leading UTF-8 BOM, which comrak counts in its columns but assigns to no
/// node, and a link reference definition, which comrak deletes. Modeling both
/// as blocks rather than as oracle exemptions keeps [`check_partition`] free of
/// special cases — it has none — and keeps them countable in a report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Block {
    pub kind: &'static str,
    pub sourcepos: Option<Sourcepos>,
    pub start: usize,
    pub end: usize,
}

impl Block {
    pub fn len(&self) -> usize {
        self.end.saturating_sub(self.start)
    }

    pub fn is_empty(&self) -> bool {
        self.end <= self.start
    }
}

/// The kind name of a block node, in `mdstruct`'s camelCase vocabulary so the
/// two tools' diagnostics read alike. Diagnostic only — nothing branches on it.
pub fn block_kind(value: &NodeValue) -> &'static str {
    match value {
        NodeValue::Document => "document",
        NodeValue::FrontMatter(_) => "frontmatter",
        NodeValue::BlockQuote => "blockQuote",
        NodeValue::MultilineBlockQuote(_) => "multilineBlockQuote",
        NodeValue::List(_) => "list",
        NodeValue::Item(_) => "listItem",
        NodeValue::TaskItem(_) => "taskItem",
        NodeValue::DescriptionList => "descriptionList",
        NodeValue::DescriptionItem(_) => "descriptionItem",
        NodeValue::DescriptionTerm => "descriptionTerm",
        NodeValue::DescriptionDetails => "descriptionDetails",
        NodeValue::CodeBlock(_) => "codeBlock",
        NodeValue::HtmlBlock(_) => "htmlBlock",
        NodeValue::Paragraph => "paragraph",
        NodeValue::Heading(_) => "heading",
        NodeValue::ThematicBreak => "thematicBreak",
        NodeValue::FootnoteDefinition(_) => "footnoteDefinition",
        NodeValue::Table(_) => "table",
        NodeValue::TableRow(_) => "tableRow",
        NodeValue::TableCell => "tableCell",
        NodeValue::Alert(_) => "alert",
        _ => "inline",
    }
}

/// Collect the byte range of every top-level block of `root`.
///
/// `root` must be the result of parsing `source` under
/// [`crate::comrak_options`]; the spans are meaningless against any other
/// text. Each span is the union of the block's own sourcepos and those of its
/// block descendants, because a container's reported end can fall short of its
/// content (see the module docs). Returns **all** position errors rather than
/// the first, since a desynced index tends to break every node after it and
/// one error would hide the pattern.
///
/// Blocks come back in source order.
pub fn block_spans<'a>(root: &'a AstNode<'a>, source: &str) -> Result<Vec<Block>, Vec<PosError>> {
    let idx = LineIndex::new(source);
    let mut blocks = Vec::new();
    let mut errors = Vec::new();

    for child in root.children() {
        let (kind, sourcepos) = {
            let data = child.data.borrow();
            (block_kind(&data.value), data.sourcepos)
        };
        let mut range = match idx.byte_span(kind, sourcepos) {
            Ok(r) => r,
            Err(e) => {
                errors.push(e);
                continue;
            }
        };
        // Expand over block descendants only. `descendants()` yields `child`
        // first; its own range is already in `range`.
        for node in child.descendants().skip(1) {
            let (nested_kind, nested_pos, is_block) = {
                let data = node.data.borrow();
                (block_kind(&data.value), data.sourcepos, data.value.block())
            };
            if !is_block {
                continue;
            }
            match idx.byte_span(nested_kind, nested_pos) {
                Ok((start, end)) => {
                    range.0 = range.0.min(start);
                    range.1 = range.1.max(end);
                }
                Err(e) => errors.push(e),
            }
        }
        blocks.push(Block {
            kind,
            sourcepos: Some(sourcepos),
            start: range.0,
            end: range.1,
        });
    }
    if !errors.is_empty() {
        return Err(errors);
    }

    // A leading BOM belongs to no node: comrak counts its three bytes in the
    // first line's columns (a heading after one reports `1:4`), so the byte
    // range stays unclaimed — except when front matter opens the file, whose
    // sourcepos starts at column 1 and so already covers it. Claim it only
    // when nothing else does, so this can never manufacture an overlap.
    if source.starts_with(BOM) {
        let n = BOM.len();
        if !blocks.iter().any(|b| b.start < n && b.end > 0) {
            blocks.push(Block {
                kind: "bom",
                sourcepos: None,
                start: 0,
                end: n,
            });
        }
    }

    fill_dropped_link_reference_definitions(source, &idx, &mut blocks);
    blocks.sort_by_key(|b| (b.start, b.end));
    Ok(blocks)
}

/// Claim the lines comrak deleted as link reference definitions.
///
/// Deliberately narrow, because every byte this claims is a byte the oracle
/// stops checking. A line is claimed only when **all** of these hold: no block
/// covers any part of it, and its text opens a link reference definition per
/// [`opens_link_reference_definition`]. One block per line, spanning that
/// line's content only. A leaked byte from a mis-measured span shares a line
/// with the span that leaked it, so it can never satisfy the first condition —
/// which is why this can coexist with the one-byte-shortening injection test.
///
/// A definition whose destination sits on a following line leaves that line
/// unclaimed and the file failing. Vault exposure is zero, and inventing a
/// continuation rule would widen exactly the tolerance this keeps narrow.
/// `tests/negative_controls.rs::a_link_reference_definition_with_a_continued_destination_loses_its_destination`
/// asserts that failure rather than leaving it as a comment, so widening the
/// fill has to break a test first.
fn fill_dropped_link_reference_definitions(source: &str, idx: &LineIndex, blocks: &mut Vec<Block>) {
    let depth = depth_map(source.len(), blocks);
    if depth.iter().all(|&d| d > 0) {
        return;
    }
    let bytes = source.as_bytes();
    for line in 1..=idx.lines() {
        let Some((start, end)) = idx.line_range(line) else {
            continue;
        };
        if start == end || depth[start..end].iter().any(|&d| d > 0) {
            continue;
        }
        if !opens_link_reference_definition(&source[start..end]) {
            continue;
        }
        let Some(first) = (start..end).find(|&i| !is_ws(bytes[i])) else {
            continue;
        };
        let last = (first..end)
            .rev()
            .find(|&i| !is_ws(bytes[i]))
            .unwrap_or(first);
        blocks.push(Block {
            kind: "linkReferenceDefinition",
            sourcepos: None,
            start: first,
            end: last + 1,
        });
    }
}

/// Does `line` open a link reference definition — `[label]:` after at most
/// three spaces of indent, with a non-empty label holding no unescaped
/// bracket? Shape only; comrak has already decided the line is one, and this
/// exists to keep the claim in [`fill_dropped_link_reference_definitions`]
/// from widening into "any unclaimed line".
pub fn opens_link_reference_definition(line: &str) -> bool {
    let indent = line.len() - line.trim_start_matches(' ').len();
    if indent > 3 {
        return false;
    }
    let Some(rest) = line[indent..].strip_prefix('[') else {
        return false;
    };
    let mut escaped = false;
    for (i, c) in rest.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match c {
            '\\' => escaped = true,
            '[' | '\n' | '\r' => return false,
            ']' => return i > 0 && rest[i + 1..].starts_with(':'),
            _ => {}
        }
    }
    false
}

/// A way a span set fails to be a partition of the source's content bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Violation {
    /// A run of bytes containing content that no block claims. `start..end` is
    /// trimmed to the first and last non-whitespace byte of the run.
    Uncovered { start: usize, end: usize },
    /// A run of bytes claimed by more than one block.
    Overlap {
        start: usize,
        end: usize,
        depth: u32,
        kinds: Vec<&'static str>,
    },
    /// A block reaching past the end of the source.
    OutOfBounds {
        kind: &'static str,
        start: usize,
        end: usize,
        len: usize,
    },
    /// A block whose end precedes its start.
    Inverted {
        kind: &'static str,
        start: usize,
        end: usize,
    },
}

/// The outcome of the partition check, with the byte accounting that makes a
/// pass quantitative rather than merely silent.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PartitionReport {
    pub violations: Vec<Violation>,
    /// Non-whitespace bytes in the source.
    pub content_bytes: usize,
    /// Non-whitespace bytes claimed by exactly one block.
    pub covered_content_bytes: usize,
    pub blocks: usize,
}

impl PartitionReport {
    /// True when the spans partition the source's content bytes.
    pub fn is_partition(&self) -> bool {
        self.violations.is_empty()
    }
}

/// How many blocks claim each byte of a `len`-byte source. Blocks reaching
/// past `len`, or inverted, claim nothing — [`check_partition`] reports those
/// separately, and marking them would corrupt the counts it reads.
fn depth_map(len: usize, blocks: &[Block]) -> Vec<u32> {
    let mut depth = vec![0u32; len];
    for b in blocks {
        if b.end > len || b.end < b.start {
            continue;
        }
        for d in &mut depth[b.start..b.end] {
            *d = d.saturating_add(1);
        }
    }
    depth
}

/// Whitespace for the oracle's purposes: space, tab, CR, LF, form feed.
///
/// This is `mdstruct`'s `is_ws` set plus form feed. Everything else — a
/// non-breaking space, U+2028, a zero-width space — counts as content and must
/// be claimed by some block. In practice comrak makes a stray non-breaking
/// space its own paragraph, so the strictness costs nothing.
pub(crate) fn is_ws(b: u8) -> bool {
    b.is_ascii_whitespace() || b == 0x0c
}

/// Check that `blocks` partition the content bytes of `source`.
///
/// Three properties, all of which a later splicing formatter depends on:
/// every non-whitespace byte lies in exactly one block, no two blocks overlap,
/// and no block reaches past the end. Whitespace between blocks is
/// unconstrained and preserved verbatim by [`reassemble`] — consecutive blank
/// lines included, since normalizing them is a separate decision from
/// establishing the partition.
///
/// This function knows nothing about markdown, and has no exemptions. It is
/// the whole reason the harness can fail.
pub fn check_partition(source: &str, blocks: &[Block]) -> PartitionReport {
    let bytes = source.as_bytes();
    let len = bytes.len();
    let mut report = PartitionReport {
        blocks: blocks.len(),
        ..Default::default()
    };
    let depth = depth_map(len, blocks);

    for b in blocks {
        if b.end < b.start {
            report.violations.push(Violation::Inverted {
                kind: b.kind,
                start: b.start,
                end: b.end,
            });
        } else if b.end > len {
            report.violations.push(Violation::OutOfBounds {
                kind: b.kind,
                start: b.start,
                end: b.end,
                len,
            });
        }
    }

    // One pass over the source, collapsing runs. An overlap run is any
    // maximal stretch at depth > 1. An uncovered run is any maximal stretch at
    // depth 0 that holds at least one content byte, reported trimmed to that
    // content so the offset points at the bytes that went missing.
    let mut i = 0usize;
    while i < len {
        let d = depth[i];
        let mut j = i + 1;
        while j < len && (depth[j] > 1) == (d > 1) && (depth[j] == 0) == (d == 0) {
            j += 1;
        }
        if d == 0 {
            let first = (i..j).find(|&k| !is_ws(bytes[k]));
            if let Some(first) = first {
                let last = (i..j).rev().find(|&k| !is_ws(bytes[k])).unwrap_or(first);
                report.violations.push(Violation::Uncovered {
                    start: first,
                    end: last + 1,
                });
            }
        } else if d > 1 {
            let mut kinds: Vec<&'static str> = blocks
                .iter()
                .filter(|b| b.start < j && b.end > i)
                .map(|b| b.kind)
                .collect();
            kinds.dedup();
            let max = depth[i..j].iter().copied().max().unwrap_or(d);
            report.violations.push(Violation::Overlap {
                start: i,
                end: j,
                depth: max,
                kinds,
            });
        }
        i = j;
    }

    for (k, &b) in bytes.iter().enumerate() {
        if !is_ws(b) {
            report.content_bytes += 1;
            if depth[k] == 1 {
                report.covered_content_bytes += 1;
            }
        }
    }

    report
}

/// Reassemble `source` from `blocks`: each block's own bytes, plus the bytes
/// between blocks, in source order.
///
/// This is the printer. It is also, on its own, a **vacuous** fixpoint check —
/// see the module docs. Run [`check_partition`] for the claim that actually
/// constrains the spans.
pub fn reassemble(source: &str, blocks: &[Block]) -> String {
    let mut ordered: Vec<&Block> = blocks.iter().collect();
    ordered.sort_by_key(|b| (b.start, b.end));

    let mut out = String::with_capacity(source.len());
    let mut cursor = 0usize;
    for b in ordered {
        let start = floor_boundary(source, b.start);
        let end = floor_boundary(source, b.end);
        if start > cursor {
            out.push_str(&source[cursor..start]);
            cursor = start;
        }
        if end > cursor {
            out.push_str(&source[cursor..end]);
            cursor = end;
        }
    }
    if cursor < source.len() {
        out.push_str(&source[cursor..]);
    }
    out
}

/// Largest character boundary `<= i`, clamped to the source. Only reachable
/// with a span set [`check_partition`] would reject; it keeps [`reassemble`]
/// from panicking on one so the oracle's report is what the caller sees.
fn floor_boundary(source: &str, i: usize) -> usize {
    let mut i = i.min(source.len());
    while !source.is_char_boundary(i) {
        i -= 1;
    }
    i
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blocks_of(source: &str) -> Vec<Block> {
        let arena = comrak::Arena::new();
        let opts = mdstruct::Options::default();
        crate::parse_with(&arena, source, &opts, |root| {
            block_spans(root, source).expect("spans convert")
        })
    }

    #[test]
    fn spans_slice_the_blocks_they_name() {
        let src = "# H\n\npara\n";
        let blocks = blocks_of(src);
        assert_eq!(blocks.len(), 2);
        assert_eq!(&src[blocks[0].start..blocks[0].end], "# H");
        assert_eq!(&src[blocks[1].start..blocks[1].end], "para");
    }

    #[test]
    fn a_partition_reports_every_content_byte_covered_once() {
        let src = "# H\n\npara\n";
        let report = check_partition(src, &blocks_of(src));
        assert!(report.is_partition(), "{:?}", report.violations);
        assert_eq!(report.content_bytes, report.covered_content_bytes);
        assert_eq!(report.content_bytes, "#Hpara".len());
    }

    #[test]
    fn an_overlap_is_a_violation() {
        let src = "# H\n\npara\n";
        let mut blocks = blocks_of(src);
        blocks[0].end = 6; // reach into the paragraph
        let report = check_partition(src, &blocks);
        assert!(matches!(
            report.violations.as_slice(),
            [Violation::Overlap { .. }]
        ));
    }

    #[test]
    fn a_span_past_the_end_is_a_violation() {
        let src = "# H\n";
        let blocks = vec![Block {
            kind: "heading",
            sourcepos: None,
            start: 0,
            end: 99,
        }];
        let report = check_partition(src, &blocks);
        assert!(matches!(
            report.violations.as_slice(),
            [
                Violation::OutOfBounds { len: 4, .. },
                Violation::Uncovered { .. }
            ]
        ));
    }

    #[test]
    fn whitespace_between_blocks_needs_no_span() {
        // Three blank lines and a tab-indented gap: all unclaimed, all fine.
        let src = "a\n\n\n\n\tb\n";
        let report = check_partition(src, &blocks_of(src));
        assert!(report.is_partition(), "{:?}", report.violations);
    }

    #[test]
    fn an_empty_source_partitions_trivially() {
        let report = check_partition("", &[]);
        assert!(report.is_partition());
        assert_eq!(report.content_bytes, 0);
        assert_eq!(report.blocks, 0);
    }

    #[test]
    fn a_leading_bom_becomes_its_own_block() {
        let src = "\u{feff}# H\n";
        let blocks = blocks_of(src);
        assert_eq!(blocks[0].kind, "bom");
        assert_eq!((blocks[0].start, blocks[0].end), (0, 3));
        assert!(check_partition(src, &blocks).is_partition());
    }

    #[test]
    fn front_matter_after_a_bom_claims_the_bom_itself() {
        // comrak reports front matter from column 1 even with a BOM ahead of
        // it, so its span already covers those bytes and no `bom` block is
        // added — adding one would be an overlap.
        let src = "\u{feff}---\ntitle: x\n---\n\nbody\n";
        let blocks = blocks_of(src);
        assert_eq!(blocks[0].kind, "frontmatter");
        assert_eq!(blocks[0].start, 0);
        assert!(check_partition(src, &blocks).is_partition());
    }

    #[test]
    fn reassemble_is_boundary_insensitive_by_construction() {
        // The documented trap, at unit scale: corrupt every span and the
        // reassembly still matches, while the partition does not.
        let src = "# H\n\npara\n";
        let blocks = blocks_of(src);
        let corrupted: Vec<Block> = blocks
            .iter()
            .map(|b| Block {
                end: b.end.saturating_sub(1).max(b.start),
                ..b.clone()
            })
            .collect();
        assert_eq!(reassemble(src, &corrupted), src);
        assert!(!check_partition(src, &corrupted).is_partition());
    }
}
