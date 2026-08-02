//! Table padding: an **opt-in** rewrite that aligns every cell of every table
//! to its column's width, guarded by three independent oracles.
//!
//! Nothing here runs unless a caller asks for it, and nothing here writes a
//! file — the same posture [`crate::normalize`] takes. [`pad`] returns a
//! candidate; [`Padding::accepted`] is the only accessor that hands out its
//! bytes, and it returns `None` unless every guard cleared.
//!
//! # The normal form
//!
//! Every table is padded. A column's width is the **terminal display width** of
//! the widest cell it holds, floored at 3 so the delimiter row always has room
//! for `---` (and for `:-:`, the widest alignment marker pair). Each cell is
//! emitted as `"|" + " " + content + fill + " "`, with `fill` on the right for
//! an unaligned or left-aligned column, on the left for a right-aligned one,
//! and split for a centered one. The delimiter cell is drawn to that same width
//! — with one exception, stated next.
//!
//! ## The trailing column, when its alignment does not need the fill
//!
//! One column is exempt: the **last** one, when it is unaligned or
//! left-aligned. Its cells get the separator space and the closing pipe and
//! nothing else, and its delimiter cell is built to the display width of the
//! **header** cell above it, floored at 3 so `---`, `:--`, `--:` and `:-:` all
//! still fit. Every other column, and a trailing column that is right- or
//! center-aligned, is padded exactly as above — an alignment means nothing
//! without the fill that realizes it, so those keep theirs, delimiter included.
//!
//! ## Why the exempt delimiter follows the header
//!
//! A dash run should tie to something the reader can see directly above it. In
//! an exempt column the column's computed width is set by its widest **body**
//! cell, and that width is realized nowhere else on the page, because no cell in
//! that column is padded to it — so a full-width delimiter draws a line under a
//! measurement no printed row carries.
//! `home/agents/skills/basecamp/SKILL.md` is the specimen: its trailing header
//! cell is `Format`, 6 columns, over a 93-column body cell, and the full-width
//! rule wrote 93 dashes beneath the 6-column word — a 150-byte delimiter line
//! under a 63-byte header line. Under this rule the two lines are both 63 bytes.
//!
//! Three widths were live, and the header was chosen over the other two: a
//! fixed `N`-dash run ties to nothing in the table, and the full computed width
//! ties to a cell whose width is printed nowhere. The header is the one width
//! that is both stable and visible where the dashes are read.
//!
//! The floor keeps the rule renderable rather than pretty: a 1-column header
//! still gets 3 dashes, because `:-:` has to fit under it.
//!
//! ## What the exemption costs, stated against it
//!
//! The exemption costs no width and saves a great deal of it. Padding every
//! column added **261 920 spaces** to the 1052-file vault corpus; the exemption
//! brings that down to **31 648 spaces** — 88% less. Those two figures are
//! unaffected by the delimiter rule, since a delimiter row's spaces are the
//! separators, not the dashes. The byte figures that accompanied them (301 561
//! and 36 217) were measured against the older, full-width delimiter rule and
//! are **not** re-measured here; over this repo's own 380 tracked `.md` files
//! the change is visible directly, and it runs the other way: the table rule's
//! net byte delta goes from **+2 232 to −2 923** — 5 155 dash bytes removed —
//! while the space delta stays **−1 047** and the same 52 files and 76 of 78
//! tables are repadded under either rule.
//!
//! It gives up nothing visible: the fill on a trailing unaligned column is
//! followed only by the closing pipe, and the table's **widest** line is
//! unchanged, because the row holding the widest trailing cell had no fill there
//! to lose — and the delimiter row, which the full-width rule made as wide as
//! that row, is now exactly as wide as the header row instead. Only the shorter
//! rows get shorter, and raggedness is never introduced *inside* a table — only
//! at the right edge, which a left-aligned column renders ragged anyway.
//!
//! What it does cost is churn, and a lot of it. The corpus's hand-padded tables
//! mostly *do* pad their trailing column, so tables that were byte-exact
//! fixpoints of the uncapped padder now change: **245 of 247** tables are
//! rewritten where the uncapped form rewrote 170, and 149 files change where 124
//! did. Of the 76 tables the uncapped padder already agreed with, 75 now lose
//! padding a human put there. Those four counts were measured over the vault
//! corpus against the full-width delimiter rule; the header-width rule can only
//! raise them, since it changes bytes in tables the exemption already rewrote
//! and can newly disagree with a hand-padded delimiter. The one survivor is
//! `20 cards/Faster CRDTs.md`, and it survives under both rules for the same
//! reason: its trailing column is right-aligned, so neither the fill exemption
//! nor the header-width delimiter reaches it.
//!
//! So the exemption trades 88% of the added whitespace for near-total
//! disagreement with the corpus's existing hand padding. `tests/table.rs` pins
//! that trade at both ends — `a_hand_padded_trailing_column_loses_its_padding`
//! for the cost, `the_corpus_alignment_specimen_is_reproduced_byte_for_byte`
//! for the survivor — rather than leaving either to a dry run, and
//! `the_trailing_delimiter_follows_the_header_and_not_the_column` pins the
//! delimiter rule on the shape that motivated it.
//!
//! ## Why display width, and not bytes or characters
//!
//! The measure has to be what a terminal renders, because the whole point of
//! padding markdown source is reading it in a terminal. Byte length is refuted
//! outright: of the corpus's padded tables whose dash counts discriminate
//! between the three measures, **zero** conform to byte length — one Cyrillic
//! table alone puts `Ключ` at 8 bytes against 4 dashes. Character count and
//! display width agree everywhere in the corpus except on cells holding emoji,
//! and there display width is the correct one: `🎉` occupies two terminal cells,
//! not one. So [`unicode_width`] settles the disagreement in the direction the
//! stated goal requires, and matches the hand-padded specimens everywhere else.
//!
//! ## Escaped pipes count the backslash
//!
//! A cell's width is measured over its **source** bytes, escapes intact, so
//! `\|` counts 2. That is the vault's own convention where it is legible:
//! `.claude/skills/obsidian-markdown/SKILL.md` runs `[[Link\|Display]]` — 17
//! characters — against 17 dashes. Measuring the *rendered* text instead would
//! need inline sourcepos, which comrak shifts one byte left per preceding `\|`
//! in the cell; measuring the source needs none of that, because
//! `TableCell` sourcepos is byte-exact with escapes intact
//! (`tests/table.rs::a_table_cells_sourcepos_is_byte_exact_with_escapes_intact`
//! pins it).
//!
//! # What this refuses to pad, and why
//!
//! A **ragged row** — one whose source cell count differs from the table's
//! column count — is skipped, and its whole table with it. comrak does not
//! model raggedness: a short row silently gains a phantom cell whose sourcepos
//! is the row's *trailing pipe*, and a long row silently loses its excess cells
//! from the AST while their bytes stay on the line. A padder driven by AST
//! cells would delete the overflow of a long row, which is content loss. Since
//! there is no column for an excess cell to be padded into, and materializing a
//! missing one changes the source's shape, the padder declines the table
//! instead of guessing. The corpus holds exactly one such table
//! (`35 experiments/2026-07-30-mdstruct-span-passthrough.md`, whose last row
//! carries an unescaped `|` inside a code span — GFM splits cells there even
//! inside backticks).
//!
//! Raggedness is detected from the **source**, not the AST, precisely because
//! the AST is what hides it: the bytes between two consecutive cells must be
//! exactly one `|`, and the bytes after the last cell must be at most one `|`
//! and whitespace. Both fail on a ragged row of either direction.
//!
//! # The three guards
//!
//! 1. **Re-parse structural equivalence** ([`crate::structure`]), whose table
//!    signature this transformation required tightening — see that module.
//! 2. **The whitespace oracle**, [`whitespace_violation`]: outside a delimiter
//!    row, the non-whitespace byte sequence of every line must be byte-identical
//!    before and after. The delimiter row is the sole exemption, because its
//!    dash count is content this rewrite is *defined* to change; there its
//!    alignment-marker pattern and its cell count are checked instead.
//! 3. **The cell oracle**, folded into the same pass: on every rewritten row
//!    line, splitting on unescaped pipes must yield the same number of segments
//!    before and after, and each segment must be byte-identical once leading and
//!    trailing **spaces** are trimmed. This is derived from the source text, not
//!    from the AST spans the rewrite was built on, so it is an independent
//!    measurement rather than a restatement.
//!
//! None of the three can catch a *wrong width*, and no oracle can: the width is
//! the transformation's own choice, and every candidate width produces the same
//! parse, the same render, and the same non-whitespace bytes. The width measure
//! is settled by the corpus evidence above, not by a guard.

use std::collections::{BTreeMap, BTreeSet};

use comrak::nodes::{AstNode, NodeValue, TableAlignment};
use unicode_width::UnicodeWidthStr;

use crate::bom::BOM;
use crate::print::{PartitionReport, block_spans, check_partition};
use crate::span::{LineIndex, PosError};
use crate::structure::{StructureDiff, structure_of};

/// Minimum column width. `---` is the conventional delimiter and `:-:` is the
/// widest marker pair, so 3 is both the vault's convention (13 of the corpus's
/// padded delimiter cells sit at exactly 3 dashes over narrower content) and
/// the floor that keeps every alignment renderable.
const MIN_WIDTH: usize = 3;

/// Why a table was left alone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkippedTable {
    /// 1-based line the table starts on.
    pub line: usize,
    pub reason: SkipReason,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkipReason {
    /// A row whose source cell count differs from the table's column count.
    RaggedRow { line: usize, reason: &'static str },
    /// A row comrak reports as spanning more than one line, which GFM cannot
    /// produce and this rewrite is not written for.
    MultiLineRow { line: usize },
    /// The delimiter row is not where a GFM table puts it, or does not read as
    /// a delimiter row over the same column count.
    DelimiterRow { line: usize, reason: &'static str },
    /// A row holding no cell at all.
    EmptyRow { line: usize },
}

impl std::fmt::Display for SkipReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SkipReason::RaggedRow { line, reason } => {
                write!(f, "ragged row at line {line}: {reason}")
            }
            SkipReason::MultiLineRow { line } => {
                write!(f, "row at line {line} spans more than one line")
            }
            SkipReason::DelimiterRow { line, reason } => {
                write!(f, "delimiter row at line {line}: {reason}")
            }
            SkipReason::EmptyRow { line } => write!(f, "row at line {line} has no cells"),
        }
    }
}

/// One line the rewrite changes, for reporting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineChange {
    /// 1-based line number.
    pub line: usize,
    pub old: String,
    pub new: String,
}

/// How the whitespace/cell oracle was violated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PadViolation {
    pub line: usize,
    pub kind: PadViolationKind,
    pub before: String,
    pub after: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PadViolationKind {
    /// The rewrite changed the number of lines.
    LineCount,
    /// A non-delimiter line's non-whitespace bytes changed.
    ContentBytes,
    /// A delimiter row gained a byte that is not `-`, `:` or `|`.
    DelimiterAlphabet,
    /// A delimiter row's cell count or alignment markers changed.
    DelimiterMarkers,
    /// A row line's unescaped-pipe segmentation changed, or a segment's
    /// space-trimmed content changed.
    CellContent,
}

impl std::fmt::Display for PadViolation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let what = match self.kind {
            PadViolationKind::LineCount => "the rewrite changed the line count",
            PadViolationKind::ContentBytes => {
                "non-whitespace bytes changed outside a delimiter row"
            }
            PadViolationKind::DelimiterAlphabet => {
                "a delimiter row holds a byte other than -, : or |"
            }
            PadViolationKind::DelimiterMarkers => {
                "a delimiter row's cells or alignment markers changed"
            }
            PadViolationKind::CellContent => "a cell's content changed, not just its padding",
        };
        write!(
            f,
            "line {}: {what}: before {:?}, after {:?}",
            self.line, self.before, self.after
        )
    }
}

/// A candidate padding and everything needed to decide whether to take it.
/// Construct with [`pad`]; read the bytes with [`Padding::accepted`].
#[derive(Debug, Clone)]
pub struct Padding {
    /// The candidate bytes. Present even when refused, so a caller can report
    /// what would have happened.
    pub output: String,
    /// Tables the parse found.
    pub tables_seen: usize,
    /// Tables at least one of whose lines changed.
    pub tables_changed: usize,
    /// Tables left byte-identical because this rewrite declines to pad them.
    pub skipped: Vec<SkippedTable>,
    /// Lines the rewrite changes.
    pub changes: Vec<LineChange>,
    /// `None` when the re-parse is structurally equivalent; otherwise why not.
    pub structure: Option<StructureDiff>,
    /// `None` when the whitespace/cell oracle passed; otherwise the first
    /// violation.
    pub violation: Option<PadViolation>,
    /// The input's partition verdict. Recorded, not gated on: unlike a gap
    /// rewrite, this one is defined by row sourcepos and whole-line ranges, so
    /// the partition is not a precondition of its soundness.
    pub input_partition: PartitionReport,
}

impl Padding {
    /// Whether the candidate differs from the input at all.
    pub fn changed(&self) -> bool {
        !self.changes.is_empty()
    }

    /// The padded bytes, or `None` when they must not be used. This is the only
    /// accessor that clears the guards, so a caller cannot take the bytes
    /// without them.
    pub fn accepted(&self) -> Option<&str> {
        (self.structure.is_none() && self.violation.is_none()).then_some(&*self.output)
    }
}

/// Whitespace that can sit *within* a line: space, tab, form feed. Line endings
/// are excluded, which is what makes every operation here single-line.
fn is_inline_ws(b: u8) -> bool {
    b == b' ' || b == b'\t' || b == 0x0c
}

/// Split `line` on pipes that are not backslash-escaped — GFM's own cell rule,
/// which applies inside code spans and every other inline construct alike.
/// Always returns at least one segment; a leading or trailing pipe therefore
/// shows up as an empty first or last segment.
pub(crate) fn split_unescaped_pipes(line: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let bytes = line.as_bytes();
    let mut seg_start = 0usize;
    let mut backslashes = 0usize;
    for (i, &b) in bytes.iter().enumerate() {
        if b == b'\\' {
            backslashes += 1;
            continue;
        }
        if b == b'|' && backslashes.is_multiple_of(2) {
            out.push(&line[seg_start..i]);
            seg_start = i + 1;
        }
        backslashes = 0;
    }
    out.push(&line[seg_start..]);
    out
}

/// Byte range of 1-based `line`'s content, line ending excluded.
pub(crate) fn line_content_range(idx: &LineIndex, line: usize) -> Option<(usize, usize)> {
    let (start, mut end) = idx.line_range(line)?;
    let bytes = idx.source().as_bytes();
    while end > start && matches!(bytes[end - 1], b'\n' | b'\r') {
        end -= 1;
    }
    Some((start, end))
}

/// One table row, resolved to the source bytes the rewrite needs.
struct Row<'s> {
    line: usize,
    start: usize,
    end: usize,
    /// Everything from the line's start up to the first cell — the container
    /// prefix plus the leading pipe when there is one. Emitted verbatim.
    head: &'s str,
    /// Raw cell source, escapes intact, surrounding spaces intact.
    cells: Vec<&'s str>,
    trailing_pipe: bool,
}

/// Resolve one `TableRow` node, or say why it cannot be padded.
fn read_row<'s, 'a>(
    source: &'s str,
    idx: &LineIndex,
    row: &'a AstNode<'a>,
    ncols: usize,
) -> Result<Row<'s>, SkipReason> {
    let sp = row.data.borrow().sourcepos;
    let line = sp.start.line;
    if sp.end.line != line {
        return Err(SkipReason::MultiLineRow { line });
    }
    let (start, end) = line_content_range(idx, line).ok_or(SkipReason::MultiLineRow { line })?;

    let mut spans = Vec::new();
    for cell in row.children() {
        let csp = cell.data.borrow().sourcepos;
        // A cell whose sourcepos does not convert is not a shape this can pad;
        // report it as ragged rather than propagate a position error, since the
        // caller's contract is "pad what you can, decline the rest".
        let r = idx
            .byte_span("tableCell", csp)
            .map_err(|_| SkipReason::RaggedRow {
                line,
                reason: "a cell's sourcepos does not name a byte range",
            })?;
        spans.push(r);
    }
    if spans.is_empty() {
        return Err(SkipReason::EmptyRow { line });
    }
    if spans.len() != ncols {
        return Err(SkipReason::RaggedRow {
            line,
            reason: "the row's cell count differs from the table's column count",
        });
    }
    if spans[0].0 < start || spans[spans.len() - 1].1 > end {
        return Err(SkipReason::RaggedRow {
            line,
            reason: "a cell reaches outside its own line",
        });
    }

    // The source-level raggedness test. comrak hides raggedness in the AST — a
    // short row gains a phantom cell over the trailing pipe, a long row drops
    // its excess — and both show up here as an adjacency that is not exactly
    // one pipe.
    for w in spans.windows(2) {
        if &source[w[0].1..w[1].0] != "|" {
            return Err(SkipReason::RaggedRow {
                line,
                reason: "two cells are not separated by exactly one pipe",
            });
        }
    }
    let tail = source[spans[spans.len() - 1].1..end]
        .trim_end_matches(|c: char| c.is_ascii() && is_inline_ws(c as u8));
    let trailing_pipe = match tail {
        "" => false,
        "|" => true,
        _ => {
            return Err(SkipReason::RaggedRow {
                line,
                reason: "content follows the row's last cell",
            });
        }
    };

    let head = &source[start..spans[0].0];
    // The head carries the container prefix and at most the leading pipe. More
    // than one pipe, or a pipe that is not the last byte, means the row's shape
    // is not what this rewrite reconstructs.
    let pipes = head.bytes().filter(|&b| b == b'|').count();
    if pipes > 1 || (pipes == 1 && !head.ends_with('|')) {
        return Err(SkipReason::RaggedRow {
            line,
            reason: "the bytes before the first cell are not a container prefix and a pipe",
        });
    }

    Ok(Row {
        line,
        start,
        end,
        head,
        cells: spans.iter().map(|&(s, e)| &source[s..e]).collect(),
        trailing_pipe,
    })
}

/// A delimiter row, resolved to what the rewrite must reproduce.
struct Delimiter<'s> {
    line: usize,
    start: usize,
    end: usize,
    head: &'s str,
    trailing_pipe: bool,
}

/// Read the delimiter row that follows `header`, or say why it cannot be
/// reconstructed. The delimiter row is not an AST node: it is the line after the
/// header row, and everything about it has to come from the source.
fn read_delimiter<'s>(
    source: &'s str,
    idx: &LineIndex,
    header: &Row<'s>,
    alignments: &[TableAlignment],
) -> Result<Delimiter<'s>, SkipReason> {
    let line = header.line + 1;
    let fail = |reason| Err(SkipReason::DelimiterRow { line, reason });
    let Some((start, end)) = line_content_range(idx, line) else {
        return fail("there is no line after the header row");
    };
    let text = &source[start..end];
    // A byte order mark is not a container prefix. Every other byte a head can
    // carry — a block quote's `> `, an indent, the leading pipe — repeats on the
    // delimiter line, which is what this comparison is for; a mark is written
    // once, on line 1, so requiring the delimiter to repeat it declined every
    // table that opened a marked file for a reason having nothing to do with
    // the table.
    let prefix = match header.head.strip_prefix(BOM) {
        Some(rest) if header.line == 1 => rest,
        _ => header.head,
    };
    if !text.starts_with(prefix) {
        return fail("it does not open with the header row's prefix");
    }
    let rest = &text[prefix.len()..];
    let mut segs: Vec<&str> = rest.split('|').collect();
    let trailing_pipe = segs.len() > 1 && segs[segs.len() - 1].trim().is_empty();
    if trailing_pipe {
        segs.pop();
    }
    if segs.len() != alignments.len() {
        return fail("its cell count differs from the table's column count");
    }
    for (seg, align) in segs.iter().zip(alignments) {
        let t = seg.trim();
        let (left, right) = (t.starts_with(':'), t.len() > 1 && t.ends_with(':'));
        let dashes = &t[usize::from(left)..t.len() - usize::from(right)];
        if dashes.is_empty() || !dashes.bytes().all(|b| b == b'-') {
            return fail("a cell is not a run of dashes with optional colons");
        }
        let derived = match (left, right) {
            (false, false) => TableAlignment::None,
            (true, false) => TableAlignment::Left,
            (false, true) => TableAlignment::Right,
            (true, true) => TableAlignment::Center,
        };
        if derived != *align {
            return fail("its colons disagree with the alignment comrak parsed");
        }
    }
    Ok(Delimiter {
        line,
        start,
        end,
        head: prefix,
        trailing_pipe,
    })
}

/// Pad `content` to `width` display columns under `align`.
fn align_pad(content: &str, width: usize, align: TableAlignment) -> String {
    let fill = width.saturating_sub(UnicodeWidthStr::width(content));
    match align {
        TableAlignment::Right => {
            let mut s = " ".repeat(fill);
            s.push_str(content);
            s
        }
        TableAlignment::Center => {
            let left = fill / 2;
            let mut s = " ".repeat(left);
            s.push_str(content);
            s.push_str(&" ".repeat(fill - left));
            s
        }
        _ => {
            let mut s = content.to_string();
            s.push_str(&" ".repeat(fill));
            s
        }
    }
}

/// The delimiter cell for a column of `width` under `align`. `width` is at
/// least [`MIN_WIDTH`], so every arm has room for its colons.
fn delimiter_cell(width: usize, align: TableAlignment) -> String {
    match align {
        TableAlignment::Left => format!(":{}", "-".repeat(width - 1)),
        TableAlignment::Right => format!("{}:", "-".repeat(width - 1)),
        TableAlignment::Center => format!(":{}:", "-".repeat(width - 2)),
        _ => "-".repeat(width),
    }
}

/// Assemble one line from a prefix and already-padded cell bodies.
///
/// `head` is the container prefix plus the leading pipe when the row has one;
/// the space that opens a cell is emitted only where a pipe precedes it, so a
/// table written without outer pipes stays written without them.
fn emit_line(head: &str, cells: &[String], trailing_pipe: bool) -> String {
    let leading_pipe = head.ends_with('|');
    let mut out = String::from(head);
    for (i, cell) in cells.iter().enumerate() {
        if i > 0 {
            out.push('|');
        }
        if i > 0 || leading_pipe {
            out.push(' ');
        }
        out.push_str(cell);
        out.push(' ');
    }
    if trailing_pipe {
        out.push('|');
    }
    // A row without a trailing pipe would otherwise end in the last cell's
    // fill; nothing is gained by trailing spaces at end of line.
    while out.ends_with(' ') {
        out.pop();
    }
    out
}

/// One line the rewrite replaces: the byte range of the line's content, the
/// bytes to put there, and whether it is a delimiter row.
struct Edit {
    line: usize,
    start: usize,
    end: usize,
    text: String,
    /// `Some(n)` on a delimiter row, where `n` is the byte length of the
    /// container prefix the oracle must see copied verbatim.
    delimiter_head: Option<usize>,
}

/// Plan the edits for one table, or the reason it is skipped.
fn plan_table<'a>(
    source: &str,
    idx: &LineIndex,
    table: &'a AstNode<'a>,
    alignments: &[TableAlignment],
) -> Result<Vec<Edit>, SkipReason> {
    let ncols = alignments.len();
    let mut rows = Vec::new();
    for row in table.children() {
        rows.push(read_row(source, idx, row, ncols)?);
    }
    let Some(header) = rows.first() else {
        return Err(SkipReason::EmptyRow { line: 0 });
    };
    let delim = read_delimiter(source, idx, header, alignments)?;

    let mut widths = vec![MIN_WIDTH; ncols];
    for row in &rows {
        for (j, cell) in row.cells.iter().enumerate() {
            let w = UnicodeWidthStr::width(cell.trim_matches(' '));
            widths[j] = widths[j].max(w);
        }
    }

    // The trailing column is exempt when nothing depends on its fill: an
    // unaligned or left-aligned last column renders the same padded or not,
    // because the only thing its fill separates the content from is the
    // closing pipe. A right- or center-aligned one is not exempt — there the
    // fill *is* the alignment. Read through `last()` so a zero-column table
    // (which `read_row` has already rejected) cannot index out of bounds.
    let bare_last = matches!(
        alignments.last(),
        Some(TableAlignment::None | TableAlignment::Left)
    );
    let is_bare = |j: usize| bare_last && j + 1 == ncols;

    let mut edits = Vec::with_capacity(rows.len() + 1);
    for row in &rows {
        let cells: Vec<String> = row
            .cells
            .iter()
            .enumerate()
            .map(|(j, c)| {
                let content = c.trim_matches(' ');
                if is_bare(j) {
                    content.to_string()
                } else {
                    align_pad(content, widths[j], alignments[j])
                }
            })
            .collect();
        edits.push(Edit {
            line: row.line,
            start: row.start,
            end: row.end,
            text: emit_line(row.head, &cells, row.trailing_pipe),
            delimiter_head: None,
        });
    }
    // The exempt column's delimiter cell is built to the width of the cell
    // physically above it — its header — rather than to the column's computed
    // width, which is the widest *body* cell and can run a dash sequence many
    // times the header it sits under. The floor still applies, so `---` and
    // every alignment marker pair fits.
    let header_width = |j: usize| {
        header
            .cells
            .get(j)
            .map_or(MIN_WIDTH, |c| UnicodeWidthStr::width(c.trim_matches(' ')))
            .max(MIN_WIDTH)
    };
    let cells: Vec<String> = widths
        .iter()
        .zip(alignments)
        .enumerate()
        .map(|(j, (&w, &a))| {
            let w = if is_bare(j) { header_width(j) } else { w };
            delimiter_cell(w, a)
        })
        .collect();
    edits.push(Edit {
        line: delim.line,
        start: delim.start,
        end: delim.end,
        text: emit_line(delim.head, &cells, delim.trailing_pipe),
        delimiter_head: Some(delim.head.len()),
    });
    Ok(edits)
}

/// The non-whitespace bytes of `line`, in order.
fn content_bytes(line: &str) -> Vec<u8> {
    line.bytes()
        .filter(|b| !b.is_ascii_whitespace() && *b != 0x0c)
        .collect()
}

/// A delimiter row's shape: per pipe-separated segment, whether it opens with a
/// colon, whether it closes with one, and whether it is empty. The dash count is
/// deliberately absent — that is the one thing this rewrite changes.
fn delimiter_markers(line: &str) -> Vec<(bool, bool, bool)> {
    line.split('|')
        .map(|seg| {
            let t = seg.trim();
            (
                t.starts_with(':'),
                t.len() > 1 && t.ends_with(':'),
                t.is_empty(),
            )
        })
        .collect()
}

/// The cell oracle's view of a row line: unescaped-pipe segments, each trimmed
/// of leading and trailing **spaces** only. Tabs inside a cell are content and
/// stay in the comparison.
fn cell_segments(line: &str) -> Vec<&str> {
    split_unescaped_pipes(line)
        .into_iter()
        .map(|s| s.trim_matches(' '))
        .collect()
}

/// The transformation-specific oracle: check that `after` differs from `before`
/// only in whitespace, except on the delimiter rows, and that no cell's content
/// changed.
///
/// This is deliberately built from the source text of both documents rather than
/// from the AST spans the rewrite was planned on, so it is an independent
/// measurement and not a restatement of the plan.
/// `delimiter_lines` maps a delimiter row's 1-based line number to the byte
/// length of its container prefix — the bytes before the table's own first
/// pipe, which a nested table carries (`> `) and a top-level one does not. The
/// exemption starts *after* that prefix, so a rewrite cannot smuggle a change
/// into a block quote's marker under cover of the delimiter row.
pub fn whitespace_violation(
    before: &str,
    after: &str,
    delimiter_lines: &BTreeMap<usize, usize>,
    row_lines: &BTreeSet<usize>,
) -> Option<PadViolation> {
    let b_idx = LineIndex::new(before);
    let a_idx = LineIndex::new(after);
    if b_idx.lines() != a_idx.lines() {
        return Some(PadViolation {
            line: 0,
            kind: PadViolationKind::LineCount,
            before: format!("{} lines", b_idx.lines()),
            after: format!("{} lines", a_idx.lines()),
        });
    }
    for line in 1..=b_idx.lines() {
        let (bs, be) = line_content_range(&b_idx, line)?;
        let (as_, ae) = line_content_range(&a_idx, line)?;
        let b = &before[bs..be];
        let a = &after[as_..ae];
        let violation = |kind| {
            Some(PadViolation {
                line,
                kind,
                before: b.to_string(),
                after: a.to_string(),
            })
        };
        if let Some(&head) = delimiter_lines.get(&line) {
            // The prefix is outside the exemption and must be copied verbatim.
            if head > b.len() || head > a.len() || b[..head] != a[..head] {
                return violation(PadViolationKind::ContentBytes);
            }
            let (b_body, a_body) = (&b[head..], &a[head..]);
            let alphabet = |s: &str| {
                s.bytes()
                    .all(|c| c.is_ascii_whitespace() || matches!(c, b'-' | b':' | b'|'))
            };
            if !alphabet(b_body) || !alphabet(a_body) {
                return violation(PadViolationKind::DelimiterAlphabet);
            }
            if delimiter_markers(b_body) != delimiter_markers(a_body) {
                return violation(PadViolationKind::DelimiterMarkers);
            }
            continue;
        }
        if content_bytes(b) != content_bytes(a) {
            return violation(PadViolationKind::ContentBytes);
        }
        if row_lines.contains(&line) && cell_segments(b) != cell_segments(a) {
            return violation(PadViolationKind::CellContent);
        }
    }
    None
}

/// Compute the padded form of `source` and check it.
///
/// Writes nothing and decides nothing: the result carries the candidate bytes,
/// the tables it declined, the lines it would change, and both guards' verdicts.
/// [`Padding::accepted`] is the only way to get bytes that cleared them.
///
/// `Err` carries every sourcepos that does not name a byte range in `source`,
/// exactly as [`crate::partition`] does.
pub fn pad(source: &str, opts: &mdstruct::Options) -> Result<Padding, Vec<PosError>> {
    let arena = comrak::Arena::new();
    let idx = LineIndex::new(source);

    type Planned = (PartitionReport, Vec<Edit>, Vec<SkippedTable>, usize, usize);
    let planned: Result<Planned, Vec<PosError>> = crate::parse_with(&arena, source, opts, |root| {
        let blocks = block_spans(root, source)?;
        let partition = check_partition(source, &blocks);
        let mut edits: Vec<Edit> = Vec::new();
        let mut skipped = Vec::new();
        let mut tables_seen = 0usize;
        let mut tables_changed = 0usize;
        for node in root.descendants() {
            let alignments = match &node.data.borrow().value {
                NodeValue::Table(t) => t.alignments.clone(),
                _ => continue,
            };
            tables_seen += 1;
            let line = node.data.borrow().sourcepos.start.line;
            match plan_table(source, &idx, node, &alignments) {
                Ok(table_edits) => {
                    if table_edits.iter().any(|e| e.text != source[e.start..e.end]) {
                        tables_changed += 1;
                    }
                    edits.extend(table_edits);
                }
                Err(reason) => skipped.push(SkippedTable { line, reason }),
            }
        }
        Ok((partition, edits, skipped, tables_seen, tables_changed))
    });
    let (input_partition, mut edits, skipped, tables_seen, tables_changed) = planned?;

    edits.sort_by_key(|e| e.start);
    let mut output = String::with_capacity(source.len());
    let mut changes = Vec::new();
    let mut delimiter_lines = BTreeMap::new();
    let mut row_lines = BTreeSet::new();
    let mut cursor = 0usize;
    for e in &edits {
        // Every edit covers one whole line's content and no two edits name the
        // same line, so the ranges are disjoint and ascending by construction.
        debug_assert!(e.start >= cursor, "table edits must not overlap");
        output.push_str(&source[cursor..e.start]);
        output.push_str(&e.text);
        cursor = e.end;
        match e.delimiter_head {
            Some(head) => {
                delimiter_lines.insert(e.line, head);
            }
            None => {
                row_lines.insert(e.line);
            }
        }
        let old = &source[e.start..e.end];
        if old != e.text {
            changes.push(LineChange {
                line: e.line,
                old: old.to_string(),
                new: e.text.clone(),
            });
        }
    }
    output.push_str(&source[cursor..]);

    let structure = structure_of(source, opts).diff(&structure_of(&output, opts));
    let violation = whitespace_violation(source, &output, &delimiter_lines, &row_lines);

    Ok(Padding {
        output,
        tables_seen,
        tables_changed,
        skipped,
        changes,
        structure,
        violation,
        input_partition,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(source: &str) -> Padding {
        pad(source, &mdstruct::Options::default()).expect("spans convert")
    }

    #[test]
    fn an_unpadded_table_gains_column_aligned_cells() {
        // The second column is the trailing one and carries no alignment
        // marker, so it is the exempt column: only `a` is padded, to the width
        // of `key`, and the dash run under `value` matches that header rather
        // than the wider `longer` below it.
        let n = p("| key | value |\n| --- | --- |\n| a | longer |\n");
        assert_eq!(
            n.accepted(),
            Some("| key | value |\n| --- | ----- |\n| a   | longer |\n")
        );
    }

    #[test]
    fn a_column_narrower_than_three_still_gets_three_dashes() {
        let n = p("| a | b |\n| - | - |\n| c | d |\n");
        assert_eq!(
            n.accepted(),
            Some("| a   | b |\n| --- | --- |\n| c   | d |\n")
        );
    }

    #[test]
    fn alignment_markers_and_their_side_survive() {
        let n = p("| a | b | c |\n| :-- | --: | :-: |\n| xxxx | yyyy | zzzz |\n");
        assert_eq!(
            n.accepted(),
            Some("| a    |    b |  c   |\n| :--- | ---: | :--: |\n| xxxx | yyyy | zzzz |\n")
        );
    }

    #[test]
    fn width_is_display_width_so_cyrillic_counts_one_per_character() {
        let n = p("| Ключ | b |\n| --- | --- |\n| x | y |\n");
        assert_eq!(
            n.accepted(),
            Some("| Ключ | b |\n| ---- | --- |\n| x    | y |\n")
        );
    }

    #[test]
    fn width_is_display_width_so_an_emoji_counts_two() {
        let n = p("| 🎉 | b |\n| --- | --- |\n| x | y |\n");
        // The emoji is one character and two columns, so its cell takes one
        // fill space to reach the floor of 3.
        assert_eq!(
            n.accepted(),
            Some("| 🎉  | b |\n| --- | --- |\n| x   | y |\n")
        );
    }

    #[test]
    fn an_escaped_pipe_counts_its_backslash() {
        let n = p("| a\\|b | c |\n| --- | --- |\n| d | e |\n");
        // `a\|b` is four source characters wide, so the column is 4.
        assert_eq!(
            n.accepted(),
            Some("| a\\|b | c |\n| ---- | --- |\n| d    | e |\n")
        );
    }

    #[test]
    fn a_ragged_row_makes_this_decline_the_whole_table() {
        let src = "| a | b | c |\n| --- | --- | --- |\n| 1 | 2 |\n";
        let n = p(src);
        assert_eq!(n.accepted(), Some(src), "the table must be left verbatim");
        assert_eq!(n.skipped.len(), 1);
        assert!(matches!(
            n.skipped[0].reason,
            SkipReason::RaggedRow { line: 3, .. }
        ));
        assert_eq!(n.tables_changed, 0);
    }

    #[test]
    fn a_row_with_more_cells_than_columns_is_ragged_too() {
        let src = "| a | b |\n| --- | --- |\n| 1 | 2 | 3 |\n";
        let n = p(src);
        assert_eq!(n.accepted(), Some(src));
        assert!(matches!(
            n.skipped[0].reason,
            SkipReason::RaggedRow { line: 3, .. }
        ));
    }

    #[test]
    fn a_table_inside_a_block_quote_keeps_its_prefix() {
        let n = p("> | a | bb |\n> | --- | --- |\n> | ccc | d |\n");
        assert_eq!(
            n.accepted(),
            Some("> | a   | bb |\n> | --- | --- |\n> | ccc | d |\n")
        );
    }

    #[test]
    fn a_table_without_outer_pipes_keeps_not_having_them() {
        let n = p("a | bb\n--- | ---\nccc | d\n");
        assert_eq!(n.accepted(), Some("a   | bb\n--- | ---\nccc | d\n"));
    }

    #[test]
    fn text_outside_a_table_is_untouched() {
        let src = "# H\n\npara |not| a table\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n";
        let n = p(src);
        let out = n.accepted().expect("accepted");
        assert!(out.starts_with("# H\n\npara |not| a table\n\n"));
        assert!(out.ends_with("| a   | b |\n| --- | --- |\n| 1   | 2 |\n"));
    }

    #[test]
    fn an_already_padded_table_is_a_fixpoint() {
        let src = "| key | value |\n| --- | ----- |\n| a   | longer |\n";
        let n = p(src);
        assert!(!n.changed());
        assert_eq!(n.accepted(), Some(src));
    }

    #[test]
    fn trailing_whitespace_after_the_last_pipe_goes() {
        let n = p("| a | b |   \n| --- | --- |\n| c | d |\n");
        assert_eq!(
            n.accepted(),
            Some("| a   | b |\n| --- | --- |\n| c   | d |\n")
        );
    }

    #[test]
    fn a_document_with_no_table_is_unchanged() {
        let src = "# H\n\npara\n";
        let n = p(src);
        assert_eq!(n.tables_seen, 0);
        assert!(!n.changed());
        assert_eq!(n.accepted(), Some(src));
    }

    #[test]
    fn splitting_on_unescaped_pipes_skips_escaped_ones() {
        assert_eq!(
            split_unescaped_pipes("| a \\| b | c |"),
            vec!["", " a \\| b ", " c ", ""]
        );
        // An escaped backslash does not escape the pipe after it.
        assert_eq!(split_unescaped_pipes("a\\\\|b"), vec!["a\\\\", "b"]);
    }
}
