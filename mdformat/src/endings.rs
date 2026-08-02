//! Line endings: every line ending LF, and the one rewrite here that reaches
//! inside a span on purpose.
//!
//! # The normal form
//!
//! | in the source | emitted |
//! | --- | --- |
//! | `"\r\n"` | `"\n"` |
//! | a lone `"\r"` | `"\n"` |
//! | `"\n"` | `"\n"` |
//!
//! No other byte is read and no other byte is written. That is the whole rule.
//!
//! # Why it had to exist
//!
//! [`crate::normalize`] states its separators as the literals `"\n"` and
//! `"\n\n"`, so a CRLF *gap* is already regenerated as LF. A CRLF between two
//! lines of one paragraph is span **interior**, and the gap rule copies span
//! interiors verbatim — so before this module, formatting a CRLF file produced
//! a file with **both** endings in it. A formatter that leaves a document
//! neither as it found it nor in any stated form is worse than one that
//! declines, and no clause of any normal form asked for that output; it fell
//! out of a rule saying nothing about line endings at all.
//!
//! LF is the ruling, on the ground that it is the default on the two systems
//! this vault lives on.
//!
//! # Every carriage return is a line ending
//!
//! This is what makes the map above **total**. CommonMark: "A line ending is a
//! newline (U+000A), a carriage return (U+000D) not followed by a newline, or a
//! carriage return and a following newline." There is no other role a `\r` can
//! play — not inside a code block, not inside a code span, not inside front
//! matter. [`crate::LineIndex`] already reads the source that way, and
//! `tests/partition.rs::lone_cr_is_a_line_ending_for_comrak_too` pins that comrak
//! agrees against a real parse.
//!
//! So this rule reads no parse. It does not need one: there is no document in
//! which "replace every carriage return" means something other than "normalize
//! every line ending".
//!
//! # Why it carries no oracle, when every other rewrite here does
//!
//! [`crate::structure`] gates [`crate::normalize`] and [`crate::table`], and it
//! cannot gate this one. Two candidate oracles, both refuted, and the second
//! refutation is the interesting one.
//!
//! **The oracle as it stands refuses this rewrite.** Measured, not assumed:
//! comrak stores line endings **verbatim** inside a `CodeBlock`, `HtmlBlock` and
//! `FrontMatter` literal, and `format_html` prints them, so `rich` and `html`
//! both differ for any CRLF document holding one — `tests/endings.rs::
//! the_structure_oracle_refuses_this_rewrite` names the specimens. Gating on it
//! would decline nearly every real CRLF file; the gap rule would then rewrite
//! those files' gaps to LF anyway, and the output would be mixed. That is the
//! defect this module exists to remove, reintroduced by its own guard.
//!
//! **An oracle blind to the bytes this changes cannot fail.** The obvious
//! repair is [`crate::structure`]'s own trick — [`crate::Structure::tables`] is
//! deliberately blind to the delimiter row's dash run, the one byte sequence
//! table padding is defined to change — so: compare the two parses with every
//! `\r` mapped out of both. But `to_lf` changes **only** `\r` bytes, so after
//! that mapping the two sides are the parses of the same string, and the
//! comparison is `None` for every input, forever. A guard that cannot fail is a
//! green light of unknown meaning, and this crate has already shipped three of
//! those (reassembly equality, the unary partition oracle, the derived
//! predicate). Adding a fourth to look guarded would be the worst of the
//! available options.
//!
//! The difference between this rule and the other two is not that it is safer to
//! run. It is that its effect is **fully determined by its own statement**. A
//! gap rewrite's effect depends on the document — deleting blank lines promotes
//! a leading `---` into front matter — so it needs a witness that reads the
//! document. This rewrite's effect does not depend on the document at all, so
//! there is nothing for a witness to read.
//!
//! What replaces the guard is a measurement, in `tests/endings.rs`: over CRLF
//! specimens covering every block shape the crate knows, the block skeleton and
//! every table's source shape survive **identically**, and the rendered HTML
//! survives identically once the `\r`s are read out of it the way an HTML parser
//! reads them out — with exactly one exception, which the next section quotes
//! and which is a repair rather than a loss.
//!
//! # What the render differences actually are
//!
//! Four shapes make `structure_of` differ, and three of the four are invisible
//! to a renderer:
//!
//! - a **fenced or indented code block**'s literal, `"code\r\n"` → `"code\n"`,
//!   printed into `<pre><code>`;
//! - an **HTML block**'s literal, likewise;
//! - **front matter**'s literal, which reaches no render at all;
//! - a **code span** crossing a line: comrak renders `` `co\r\nde` `` as
//!   `<code>co\r de</code>` and `` `co\nde` `` as `<code>co de</code>`.
//!
//! The HTML spec normalizes `\r\n` and `\r` to `\n` during input preprocessing,
//! before any element sees them, so the first three change no rendered
//! character. The fourth is the one place the rewrite changes what a reader
//! sees, and it changes it **toward** the specification: CommonMark converts each
//! line ending in a code span to one space, `\r\n` is one line ending, and
//! `co de` is the conforming render that comrak produces only after this rule
//! has run.
//!
//! # Why it runs first
//!
//! [`crate::format::RULES`] puts this at the head, so no later rule
//! ever sees a `\r`.
//!
//! Not for the output's sake: the endings rule reaches the same bytes from any
//! position in the pipeline, because the gap rule regenerates its separators as
//! LF wherever it runs. It is for the **specification's** sake. Neither of the
//! other two rules states anything about a carriage return — the gap rule's
//! normal form is a table of LF literals, the table rule's is a table of widths —
//! so whatever they do with one is incidental rather than specified. Running the
//! canonicalization first means that question belongs to exactly one rule, and
//! that every later rule's span interiors are CR-free. The discipline they rely
//! on is **strengthened**, not weakened, by the one rule that breaks it.

use crate::span::LineIndex;

/// One line ending the rewrite would change, in the source's own coordinates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EndingChange {
    /// 1-based line this ending terminates.
    pub line: usize,
    /// 1-based column of the `\r`.
    pub column: usize,
    /// Byte offset of the `\r`.
    pub start: usize,
    /// What the source holds there: `"\r\n"` or `"\r"`.
    pub old: &'static str,
}

/// The LF rewrite of one document: the bytes, and every ending that changed.
///
/// Unlike [`crate::Normalization`] and [`crate::Padding`] this has no
/// `accepted`, because it has no guard to clear — see the module docs for why
/// a guard here would be either wrong or vacuous.
#[derive(Debug, Clone)]
pub struct LineEndings {
    /// The rewritten bytes. Holds no `\r`.
    pub output: String,
    /// Every ending that was not already LF.
    pub changes: Vec<EndingChange>,
}

impl LineEndings {
    /// Whether the rewrite differs from its input.
    pub fn changed(&self) -> bool {
        !self.changes.is_empty()
    }
}

/// Rewrite every line ending in `source` to LF.
///
/// Total and context-free: it reads no parse, takes no options, and cannot
/// fail. Every `\r` is a line ending (see the module docs), so `\r\n` and a
/// lone `\r` each become one `\n` and every other byte is copied.
pub fn to_lf(source: &str) -> LineEndings {
    let bytes = source.as_bytes();
    let idx = LineIndex::new(source);
    let mut output = String::with_capacity(source.len());
    let mut changes = Vec::new();
    let mut cursor = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] != b'\r' {
            i += 1;
            continue;
        }
        let crlf = bytes.get(i + 1) == Some(&b'\n');
        let (line, column) = idx.position_of(i);
        changes.push(EndingChange {
            line,
            column,
            start: i,
            old: if crlf { "\r\n" } else { "\r" },
        });
        output.push_str(&source[cursor..i]);
        output.push('\n');
        i += if crlf { 2 } else { 1 };
        cursor = i;
    }
    output.push_str(&source[cursor..]);
    LineEndings { output, changes }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crlf_becomes_lf() {
        let e = to_lf("# H\r\n\r\nbody\r\n");
        assert_eq!(e.output, "# H\n\nbody\n");
        assert_eq!(e.changes.len(), 3);
        assert!(e.changed());
    }

    #[test]
    fn a_lone_cr_becomes_lf_too() {
        // A lone `\r` is a CommonMark line ending like any other, so leaving it
        // would let the output mix two endings just as surely as CRLF would.
        let e = to_lf("a\r## H\rbody\r");
        assert_eq!(e.output, "a\n## H\nbody\n");
        assert_eq!(
            e.changes.iter().map(|c| c.old).collect::<Vec<_>>(),
            ["\r"; 3]
        );
    }

    #[test]
    fn an_lf_only_document_is_untouched() {
        for src in ["", "# H\n\nbody\n", "no trailing newline", "\n\n   \n"] {
            let e = to_lf(src);
            assert_eq!(e.output, src);
            assert!(!e.changed());
        }
    }

    #[test]
    fn a_mixed_document_is_reported_ending_by_ending() {
        // The shape the rule exists for. Coordinates address the source: the
        // `\r\n` ends line 2 at column 5, the lone `\r` ends line 3 at column 3.
        let e = to_lf("lf\ncrlf\r\ncr\rend\n");
        assert_eq!(e.output, "lf\ncrlf\ncr\nend\n");
        assert_eq!(
            e.changes
                .iter()
                .map(|c| (c.line, c.column, c.old))
                .collect::<Vec<_>>(),
            vec![(2, 5, "\r\n"), (3, 3, "\r")]
        );
    }

    #[test]
    fn the_output_holds_no_carriage_return_and_the_rewrite_is_a_fixpoint() {
        for src in ["a\r\nb\r", "\r", "\r\n", "a\r\r\nb", "x\n\ry\r\n"] {
            let once = to_lf(src).output;
            assert!(!once.contains('\r'), "{src:?} left a CR in {once:?}");
            assert_eq!(to_lf(&once).output, once, "{src:?} is not a fixpoint");
        }
    }
}
