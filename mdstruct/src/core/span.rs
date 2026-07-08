//! The ONE place line/column → half-open byte span is computed (comrak gap #1).
//!
//! comrak's `Sourcepos` is 1-based line/col where the column is a UTF-8 **byte**
//! count within the line (the default; `parse.sourcepos_chars` is NOT enabled)
//! and `end` points at the **last byte** of the node's last character. So the
//! exclusive end is `line_start(end.line) + end.column` — no `char_boundary`
//! walk, and NEVER `+ utf8_len(last_char)` (a char-count-mode habit that
//! overshoots 1–3 bytes on any multibyte-terminal block). Decision 14.

use comrak::nodes::Sourcepos;

use super::model::Span;

/// `starts[L - 1]` is the byte offset at which 1-based line `L` begins;
/// `starts[0] == 0`.
pub struct LineIndex {
    starts: Vec<usize>,
    len: usize,
}

impl LineIndex {
    pub fn new(source: &str) -> Self {
        let mut starts = vec![0usize];
        let bytes = source.as_bytes();
        for (i, &b) in bytes.iter().enumerate() {
            // Line start after each CommonMark line ending, matching comrak's
            // sourcepos: after every `\n`, and after a lone `\r` (not followed
            // by `\n`). `\r\n` is one ending; the start lands after the `\n`.
            let is_break = b == b'\n' || (b == b'\r' && bytes.get(i + 1) != Some(&b'\n'));
            if is_break {
                starts.push(i + 1);
            }
        }
        LineIndex {
            starts,
            len: source.len(),
        }
    }

    /// Byte offset at which 1-based `line` begins. Out-of-range lines clamp to
    /// end-of-source so arithmetic never panics; the tiling gate catches any
    /// resulting inconsistency.
    pub fn line_start(&self, line: usize) -> usize {
        if line == 0 {
            return 0;
        }
        self.starts.get(line - 1).copied().unwrap_or(self.len)
    }

    /// Byte offset at which 1-based `line` ends (start of the next line, or EOF).
    pub fn next_line_start(&self, line: usize) -> usize {
        self.line_start(line + 1)
    }

    pub fn len(&self) -> usize {
        self.len
    }

    /// Number of lines; a trailing newline does not add an empty final line.
    /// `new` pushes a start after every `\n`, so a source ending in `\n`
    /// records a phantom final start equal to `len`; drop it so heading
    /// `sectionEndLine` is not one too high.
    pub fn line_count(&self) -> usize {
        if self.len > 0 && self.starts.last() == Some(&self.len) {
            self.starts.len() - 1
        } else {
            self.starts.len()
        }
    }

    /// Convert a comrak `Sourcepos` to a half-open byte span.
    ///
    /// `start = line_start(start.line) + (start.column - 1)`,
    /// `end   = line_start(end.line) + end.column` (exclusive, byte-column mode).
    /// Both are clamped to `[0, len]`; a clamp that actually fires is a signal
    /// the tiling gate will surface.
    pub fn span_of(&self, sp: Sourcepos) -> Span {
        let start = (self.line_start(sp.start.line) + sp.start.column.saturating_sub(1)).min(self.len);
        let end = (self.line_start(sp.end.line) + sp.end.column).min(self.len);
        Span::new(start, end.max(start))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_start_indexes_lines() {
        // "a\nbb\nccc" → line 1 @0, line 2 @2, line 3 @5
        let idx = LineIndex::new("a\nbb\nccc");
        assert_eq!(idx.line_start(1), 0);
        assert_eq!(idx.line_start(2), 2);
        assert_eq!(idx.line_start(3), 5);
    }

    #[test]
    fn exclusive_end_on_ascii() {
        // "# Guide" occupies line 1, cols 1..7; last char 'e' at byte-col 7.
        let idx = LineIndex::new("# Guide\n");
        let sp = Sourcepos::from((1, 1, 1, 7));
        let span = idx.span_of(sp);
        assert_eq!((span.start, span.end), (0, 7));
    }

    #[test]
    fn exclusive_end_on_cyrillic_terminal() {
        // "## Заметка": '#','#',' ' = 3 bytes, then 7 Cyrillic chars × 2 bytes.
        // Last char 'а' occupies byte-cols 16..17, so end.column = 17 and the
        // exclusive end is 17 — the whole string. Overshooting by utf8_len would
        // land at 18+ and corrupt write-back.
        let src = "## Заметка\n";
        let idx = LineIndex::new(src);
        let heading_bytes = "## Заметка".len();
        assert_eq!(heading_bytes, 17);
        let sp = Sourcepos::from((1, 1, 1, 17));
        let span = idx.span_of(sp);
        assert_eq!((span.start, span.end), (0, 17));
        assert_eq!(&src[span.start..span.end], "## Заметка");
    }

    #[test]
    fn lone_cr_is_a_line_ending() {
        // CommonMark (and comrak's sourcepos) treats a lone `\r` — one not
        // immediately followed by `\n` — as a line ending. In "a\r## H\nbody"
        // the heading begins on line 2 at byte 2. A LineIndex that counted only
        // `\n` would place line 2 at byte 7, desyncing every following span.
        let src = "a\r## H\nbody";
        let idx = LineIndex::new(src);
        assert_eq!(idx.line_start(2), 2);
        assert_eq!(idx.line_start(3), 7);
        // comrak reports the atx heading at (2, 1, 2, 4); span_of must slice it.
        let sp = Sourcepos::from((2, 1, 2, 4));
        let span = idx.span_of(sp);
        assert_eq!((span.start, span.end), (2, 6));
        assert_eq!(&src[span.start..span.end], "## H");
    }

    #[test]
    fn crlf_pair_is_one_line_ending() {
        // A `\r\n` pair is a single CommonMark line ending: no start is added
        // between the `\r` and the `\n`. "a\r\nb" stays two lines — exactly the
        // count produced when only `\n` was recognized.
        let idx = LineIndex::new("a\r\nb");
        assert_eq!(idx.line_count(), 2);
        assert_eq!(idx.line_start(1), 0);
        assert_eq!(idx.line_start(2), 3);
    }
}
