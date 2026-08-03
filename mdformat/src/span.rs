//! Line/column → byte offset, the one place `mdformat` does that arithmetic.
//!
//! The formula is `mdstruct`'s (`mdstruct/src/core/span.rs:77-82`), because it
//! has to be: comrak's `Sourcepos` is 1-based line/column where the column
//! counts UTF-8 **bytes** within the line (`parse.sourcepos_chars` is not
//! enabled) and `end` points at the **last byte** of the node's last
//! character, so
//!
//! ```text
//! start = line_start(start.line) + (start.column - 1)
//! end   = line_start(end.line)   + end.column
//! ```
//!
//! `LineIndex::new` also keeps `mdstruct`'s line-ending rule: `\n`, `\r\n`,
//! and a lone `\r` each end a line, per CommonMark. That comrak agrees is not
//! assumed — `tests/partition.rs::lone_cr_is_a_line_ending_for_comrak_too`
//! pins it against a real parse, where a `\n`-only index would place the
//! second line seven bytes too late.
//!
//! One behavior is deliberately **not** `mdstruct`'s: that module clamps both
//! ends with `.min(len)` and `end.max(start)`. A clamp is defensible in a
//! linter, where an out-of-range position merely shortens a span and the
//! tiling gate may notice. In a printer it silently emits the wrong bytes, so
//! here every out-of-range position is a [`PosError`] naming the node kind and
//! the position; the caller adds the file name.

use std::fmt;

use comrak::nodes::Sourcepos;

/// Byte offsets of line starts, plus the source they index.
///
/// `starts[L - 1]` is the byte offset at which 1-based line `L` begins, and
/// `starts[0] == 0` always. A source ending in a line ending records a final
/// start equal to `source.len()` — the empty line after the last newline —
/// which comrak does address: an indented code block reports its end as
/// `line:0` of the line *after* its content (`"    code\n\n"` → `1:5-2:0`).
#[derive(Debug, Clone)]
pub struct LineIndex<'s> {
    source: &'s str,
    starts: Vec<usize>,
}

impl<'s> LineIndex<'s> {
    pub fn new(source: &'s str) -> Self {
        let mut starts = vec![0usize];
        let bytes = source.as_bytes();
        for (i, &b) in bytes.iter().enumerate() {
            // A line starts after each CommonMark line ending: after every
            // `\n`, and after a lone `\r` not followed by `\n`. `\r\n` is one
            // ending, and the start lands after the `\n`.
            let is_break = b == b'\n' || (b == b'\r' && bytes.get(i + 1) != Some(&b'\n'));
            if is_break {
                starts.push(i + 1);
            }
        }
        LineIndex { source, starts }
    }

    pub fn source(&self) -> &'s str {
        self.source
    }

    pub fn len(&self) -> usize {
        self.source.len()
    }

    pub fn is_empty(&self) -> bool {
        self.source.is_empty()
    }

    /// Number of addressable lines — indexed line starts, including the empty
    /// line a trailing line ending opens. Any 1-based line above this is out
    /// of range and produces [`PosReason::LineOutOfRange`].
    pub fn lines(&self) -> usize {
        self.starts.len()
    }

    /// Byte offset at which 1-based `line` begins, or `None` when `line` is 0
    /// or past the end of the source.
    pub fn line_start(&self, line: usize) -> Option<usize> {
        if line == 0 {
            return None;
        }
        self.starts.get(line - 1).copied()
    }

    /// Half-open byte range of 1-based `line`, line ending included, or `None`
    /// when the line is out of range. The last line runs to the end of source.
    pub fn line_range(&self, line: usize) -> Option<(usize, usize)> {
        let start = self.line_start(line)?;
        let end = self.line_start(line + 1).unwrap_or_else(|| self.len());
        Some((start, end))
    }

    /// 1-based (line, byte-column) of `offset`, for legible diagnostics.
    /// Offsets past the end report the last line.
    pub fn position_of(&self, offset: usize) -> (usize, usize) {
        let i = match self.starts.binary_search(&offset) {
            Ok(i) => i,
            // `starts[0] == 0 <= offset`, so the insertion point is never 0.
            Err(i) => i - 1,
        };
        (i + 1, offset - self.starts[i] + 1)
    }

    /// Convert one node's `Sourcepos` to a half-open byte range.
    ///
    /// Every way the conversion can go wrong is an error, never a clamp:
    /// a line outside the source, a start column of 0 (columns are 1-based),
    /// an offset past the end, an inverted range, or an offset that is not a
    /// UTF-8 character boundary — the last of which would otherwise panic on
    /// the slice.
    pub fn byte_span(&self, kind: &'static str, sp: Sourcepos) -> Result<(usize, usize), PosError> {
        let fail = |reason| {
            Err(PosError {
                kind,
                sourcepos: sp,
                reason,
            })
        };
        if sp.start.column == 0 {
            return fail(PosReason::StartColumnZero);
        }
        let Some(start_line) = self.line_start(sp.start.line) else {
            return fail(PosReason::LineOutOfRange {
                line: sp.start.line,
                lines: self.lines(),
            });
        };
        let Some(end_line) = self.line_start(sp.end.line) else {
            return fail(PosReason::LineOutOfRange {
                line: sp.end.line,
                lines: self.lines(),
            });
        };
        let start = start_line + (sp.start.column - 1);
        let end = end_line + sp.end.column;
        let len = self.len();
        if start > len {
            return fail(PosReason::PastEnd { offset: start, len });
        }
        if end > len {
            return fail(PosReason::PastEnd { offset: end, len });
        }
        if end < start {
            return fail(PosReason::Inverted { start, end });
        }
        if !self.source.is_char_boundary(start) {
            return fail(PosReason::NotCharBoundary { offset: start });
        }
        if !self.source.is_char_boundary(end) {
            return fail(PosReason::NotCharBoundary { offset: end });
        }
        Ok((start, end))
    }
}

/// A `Sourcepos` that does not name a byte range in this source. Carries the
/// node kind and the position so the message can point at the construct; the
/// caller prefixes the file name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PosError {
    pub kind: &'static str,
    pub sourcepos: Sourcepos,
    pub reason: PosReason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PosReason {
    /// comrak named a line the source does not have.
    LineOutOfRange { line: usize, lines: usize },
    /// A start column of 0; comrak's columns are 1-based.
    StartColumnZero,
    /// A converted offset past the last byte. `mdstruct` clamps here.
    PastEnd { offset: usize, len: usize },
    /// `end` before `start`.
    Inverted { start: usize, end: usize },
    /// An offset landing inside a multi-byte character.
    NotCharBoundary { offset: usize },
}

impl fmt::Display for PosError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let sp = self.sourcepos;
        write!(
            f,
            "{} at {}:{}-{}:{}: ",
            self.kind, sp.start.line, sp.start.column, sp.end.line, sp.end.column
        )?;
        match self.reason {
            PosReason::LineOutOfRange { line, lines } => {
                write!(f, "line {line} is out of range (source has {lines} lines)")
            }
            PosReason::StartColumnZero => write!(f, "start column 0, but columns are 1-based"),
            PosReason::PastEnd { offset, len } => {
                write!(
                    f,
                    "byte offset {offset} is past the end of the source ({len})"
                )
            }
            PosReason::Inverted { start, end } => {
                write!(f, "inverted byte range {start}..{end}")
            }
            PosReason::NotCharBoundary { offset } => {
                write!(f, "byte offset {offset} is not a UTF-8 character boundary")
            }
        }
    }
}

impl std::error::Error for PosError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn indexes_line_starts() {
        let idx = LineIndex::new("a\nbb\nccc");
        assert_eq!(idx.line_start(1), Some(0));
        assert_eq!(idx.line_start(2), Some(2));
        assert_eq!(idx.line_start(3), Some(5));
        assert_eq!(idx.line_start(4), None);
        assert_eq!(idx.line_start(0), None);
    }

    #[test]
    fn a_trailing_newline_opens_one_addressable_empty_line() {
        // comrak addresses it: `"    code\n\n"` reports `1:5-2:0`, whose end
        // resolves through line 2's start.
        let idx = LineIndex::new("a\n");
        assert_eq!(idx.lines(), 2);
        assert_eq!(idx.line_start(2), Some(2));
    }

    #[test]
    fn lone_cr_starts_a_line_and_crlf_does_not_start_two() {
        let idx = LineIndex::new("a\r## H\nbody");
        assert_eq!(idx.line_start(2), Some(2));
        assert_eq!(idx.line_start(3), Some(7));
        let crlf = LineIndex::new("a\r\nb");
        assert_eq!(crlf.lines(), 2);
        assert_eq!(crlf.line_start(2), Some(3));
    }

    #[test]
    fn end_column_is_the_last_byte_not_the_last_char() {
        // "## Заметка" is 17 bytes; the final 'а' occupies byte-columns 16..17,
        // so comrak reports end.column 17 and the exclusive end is 17. Adding
        // the last character's UTF-8 length instead would overshoot.
        let src = "## Заметка\n";
        let idx = LineIndex::new(src);
        let span = idx
            .byte_span("heading", Sourcepos::from((1, 1, 1, 17)))
            .unwrap();
        assert_eq!(span, (0, 17));
        assert_eq!(&src[span.0..span.1], "## Заметка");
    }

    #[test]
    fn end_column_zero_resolves_to_the_start_of_that_line() {
        // An indented code block's end: `"para\n\n    code\n\nafter\n"` → 3:5-4:0.
        let src = "para\n\n    code\n\nafter\n";
        let idx = LineIndex::new(src);
        let span = idx
            .byte_span("codeBlock", Sourcepos::from((3, 5, 4, 0)))
            .unwrap();
        assert_eq!(&src[span.0..span.1], "code\n");
    }

    #[test]
    fn an_out_of_range_line_is_an_error_not_a_clamp() {
        let idx = LineIndex::new("# H\n");
        let err = idx
            .byte_span("heading", Sourcepos::from((9, 1, 9, 3)))
            .unwrap_err();
        assert_eq!(err.reason, PosReason::LineOutOfRange { line: 9, lines: 2 });
    }

    #[test]
    fn an_end_past_the_source_is_an_error_where_mdstruct_would_clamp() {
        // mdstruct's `span_of` returns 0..4 here (`.min(len)`); a printer that
        // did the same would emit a silently shortened block.
        let idx = LineIndex::new("# H\n");
        let err = idx
            .byte_span("heading", Sourcepos::from((1, 1, 1, 99)))
            .unwrap_err();
        assert_eq!(err.reason, PosReason::PastEnd { offset: 99, len: 4 });
    }

    #[test]
    fn a_mid_character_offset_is_an_error_not_a_panic() {
        // Byte 1 is inside 'я'. Slicing there would panic.
        let idx = LineIndex::new("я\n");
        let err = idx
            .byte_span("paragraph", Sourcepos::from((1, 2, 1, 2)))
            .unwrap_err();
        assert_eq!(err.reason, PosReason::NotCharBoundary { offset: 1 });
    }

    #[test]
    fn position_of_reports_one_based_line_and_column() {
        let idx = LineIndex::new("ab\ncd\n");
        assert_eq!(idx.position_of(0), (1, 1));
        assert_eq!(idx.position_of(1), (1, 2));
        assert_eq!(idx.position_of(3), (2, 1));
        assert_eq!(idx.position_of(4), (2, 2));
    }
}
