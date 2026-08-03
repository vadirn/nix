//! The byte order mark, and the two places it is still a special case.
//!
//! A UTF-8 byte order mark is three bytes — `EF BB BF` — and it occupies them
//! on line 1 of a document and on no other line. Everything this crate does
//! rests on that: a span is a byte range derived from a line/column pair, so a
//! column reported one line down has to be measured from *that* line's start.
//!
//! comrak agrees. It strips the mark before parsing and then adds its three
//! bytes back into line 1's columns, which is right — `\u{feff}# H` reports the
//! heading at `1:4`, and the mark really does sit in front of it. Every later
//! line is reported mark-free.
//!
//! The mark used to own a repair here, because a table opening on line 1 carried
//! the mark's three bytes onto every row below it. That turned out to be one
//! shape of a wider defect — comrak anchors every table row at the *header's*
//! opening offset, whatever that offset is made of — and the repair now lives in
//! [`crate::anchor`], keyed on each row's own opening rather than on the mark.
//! A mark is one prefix line 1 carries and later lines do not; an indent a lazy
//! row omits is another, and it is not three bytes wide.
//!
//! What is left is the mark as *bytes belonging to no node*:
//!
//! - [`crate::print::block_spans`] emits a `bom` block for them, because no
//!   comrak node claims them and the partition has to account for every byte.
//! - [`crate::table`]'s delimiter-row reader strips them from a header row's
//!   prefix before requiring the delimiter row to repeat it. Every other byte a
//!   prefix can hold — a block quote's `> `, an indent, the leading pipe — does
//!   repeat on the delimiter line; a mark is written once.

/// A byte order mark, UTF-8 encoded: the three bytes `EF BB BF`.
pub const BOM: &str = "\u{feff}";
