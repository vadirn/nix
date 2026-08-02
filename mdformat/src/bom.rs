//! The byte order mark, and the one place comrak miscounts it.
//!
//! A UTF-8 byte order mark is three bytes — `EF BB BF` — and it occupies them
//! on line 1 of a document and on no other line. Everything this crate does
//! rests on that: a span is a byte range derived from a line/column pair, so a
//! column reported one line down has to be measured from *that* line's start.
//!
//! comrak agrees everywhere but one construct. It strips the mark before
//! parsing and then adds its three bytes back into line 1's columns, which is
//! right — `\u{feff}# H` reports the heading at `1:4`, and the mark really does
//! sit in front of it. Every later line is reported mark-free: a paragraph, a
//! list item, a block quote's continuation, a fence's closing line and a setext
//! underline all come back at the columns they occupy.
//!
//! A **table opening on line 1** does not. comrak gives each of its rows and
//! cells the table's opening offset on line 1 — the mark's bytes included —
//! plus that node's offset within its row, because the offset a container
//! contributes is assumed to repeat on every line the container spans. A block
//! quote's `> ` and an indent do repeat, so those shapes come back correct. A
//! mark is written once and never repeats, so every row below the header comes
//! back three columns to the right of where it is. On the shortest specimen —
//! `\u{feff}|a|\n|-|\n|1|\n`, 15 bytes — the last cell's span ran to byte 16 and
//! [`crate::span::LineIndex::byte_span`] refused it as past the end, which is
//! how the defect surfaced: `format` and `check` reported a sourcepos error and
//! formatted nothing.
//!
//! The mark is not the only way to break that assumption, only the one repaired
//! here. An indented table whose last row is a **lazy continuation** carrying no
//! indent breaks it the same way and still errors;
//! `tests/write.rs::an_erroring_document_is_left_alone` holds that shape as an
//! asserted refusal. It is left alone because its carry is not a fixed width:
//! correcting it means re-deriving each row's own indent from the source, where
//! a mark's carry is known to be exactly three bytes from the source's first
//! three bytes alone.
//!
//! # What [`repair_table_columns`] corrects, and what it must not touch
//!
//! Three conditions gate the repair, and each of them is a measured boundary
//! rather than a precaution:
//!
//! 1. **The source opens with a mark.** Nothing else puts bytes on line 1 that
//!    are absent from every later line.
//! 2. **The table opens on line 1.** A table further down the same marked
//!    document takes its opening offset from a mark-free line and is already
//!    correct — `\u{feff}intro\n\n|a|\n|-|\n|1|\n` reports its rows at the
//!    columns they occupy.
//! 3. **The column sits on a line after line 1.** Line 1's columns are three
//!    bytes further right, because the mark is there.
//!
//! Within the table, one field is excluded: a [`NodeValue::Table`]'s and a
//! [`NodeValue::TableRow`]'s own `end`. comrak takes those from the length of
//! the line they land on, not from the table's opening offset, so they are
//! already right — and subtracting from them would move a correct column. The
//! division is visible in comrak's own output: a marked one-column table reports
//! its second row as `3:4-3:3`, a start three columns right of an end that never
//! moved. Cells and the inline nodes beneath them take both ends from the
//! offset arithmetic, so both ends are corrected.
//!
//! `tests/table.rs::a_byte_order_mark_shifts_only_line_one_columns_inside_a_table`
//! pins all four claims against a real parse in both directions: it asserts a
//! marked document's sourcepos equals the unmarked one's with three added to
//! every column on line 1 and nothing added anywhere else, so under-repairing
//! and over-repairing both redden it.
//!
//! # Why the repair lives at the parse seam
//!
//! [`crate::parse_with`] is the crate's single parse, and the miscount reaches
//! more than one reader: [`crate::print::block_spans`] converts cell positions
//! to byte ranges, and [`crate::table::pad`] slices the source at them to read a
//! cell's text. Correcting it in the printer alone would stop the error and
//! leave the padder measuring the wrong bytes. Correcting comrak's output once,
//! where it enters the crate, is what makes every downstream reader see the same
//! positions — and it is why a caller needs no BOM knowledge of its own.

use comrak::nodes::{AstNode, NodeValue};

/// A byte order mark, UTF-8 encoded: the three bytes `EF BB BF`.
pub const BOM: &str = "\u{feff}";

/// Remove the leading byte order mark's width from the columns comrak carried
/// onto lines that never held it.
///
/// A no-op unless `source` opens with [`BOM`] and holds a table that opens on
/// line 1; see the module docs for why those are the boundary and for the one
/// field inside such a table that is deliberately left alone. `root` must be
/// the result of parsing `source`.
pub fn repair_table_columns<'a>(root: &'a AstNode<'a>, source: &str) {
    if !source.starts_with(BOM) {
        return;
    }
    let mark = BOM.len();
    for table in root.descendants() {
        {
            let data = table.data.borrow();
            let is_line_one_table =
                matches!(data.value, NodeValue::Table(_)) && data.sourcepos.start.line == 1;
            if !is_line_one_table {
                continue;
            }
        }
        for node in table.descendants() {
            let mut data = node.data.borrow_mut();
            // A table's and a row's `end` come from the length of the line they
            // land on, not from the table's opening offset, so they never
            // carried the mark.
            let end_is_line_measured =
                matches!(data.value, NodeValue::Table(_) | NodeValue::TableRow(_));
            let sp = &mut data.sourcepos;
            // A carried column is the true column plus three, so it always
            // exceeds three. The guard makes a column that somehow did not
            // carry stay untouched rather than wrap into a wrong one.
            if sp.start.line > 1 && sp.start.column > mark {
                sp.start.column -= mark;
            }
            if !end_is_line_measured && sp.end.line > 1 && sp.end.column > mark {
                sp.end.column -= mark;
            }
        }
    }
}
