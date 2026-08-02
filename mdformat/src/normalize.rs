//! Blank-line normalization: an **opt-in** rewrite of the whitespace *between*
//! top-level blocks, guarded by re-parse structural equivalence.
//!
//! Nothing here runs unless a caller asks for it. `mdformat`'s default is still
//! the passthrough printer of [`crate::print`], which changes no byte of any
//! file; when this rewrite is permitted to touch real files is an open
//! decision, and this module deliberately does not answer it — it has no write
//! path at all, and [`normalize`] returns a candidate rather than performing
//! anything.
//!
//! # The normal form
//!
//! Top-level gaps only. No recursion into containers.
//!
//! | position | emitted |
//! | --- | --- |
//! | before the first block | `""` |
//! | after a `bom` block | `""` |
//! | after `frontmatter` | `"\n\n"` (exactly one blank line) |
//! | between any other two top-level blocks | `"\n\n"` (exactly one blank line) |
//! | after the last block | `"\n"` |
//!
//! Rule 4 — no trailing whitespace on an otherwise-blank line — needs no clause
//! of its own: a gap is *regenerated*, not edited, so whatever whitespace a
//! blank line in a gap carried is gone. Trailing whitespace on a **content**
//! line is out of scope by the same rule's wording, and stays (see the span
//! definition below, which is what makes that true).
//!
//! The front-matter clause is what the table says and no more: front matter is
//! followed by exactly one blank line, like every other block. That codifies
//! the vault's existing convention instead of fighting it. The opposite
//! clause — *no* blank line after front matter — was measured and withdrawn: it
//! changed 988 of 1052 corpus files for a cosmetic preference, 990 of the 1009
//! gap rewrites it produced. Keeping this one costs 0 corpus files.
//!
//! # Why not recurse
//!
//! Two measured reasons, either fatal.
//!
//! **The rule's output alphabet is container-dependent.** Inside a block quote
//! "one blank line" is `>`, not empty: `> a\n>\n> b` is one quote with two
//! paragraphs and `> a\n\n> b` is two quotes. A recursive rule would have to
//! emit the container's continuation prefix, which means it is no longer
//! rewriting gap bytes — inside a container the separator is span *interior*,
//! and never touching a span's interior is how **this** rule earns its
//! faithfulness. That is a proof strategy, not the crate's safety property:
//! [`crate::endings`] rewrites span interiors and is faithful for a different
//! reason, which [`crate::format`] sets out. The strategy is the one available
//! here because a gap rewrite's effect depends on the document — which is
//! exactly why it also needs the guard below.
//!
//! **Applied between list items it would loosen every tight list.** The corpus
//! holds 2532 tight lists (12770 items); one blank line between children makes
//! every one loose and changes the rendered HTML of all of them.
//!
//! So the rule governs 12897 of the corpus's 13271 non-code blank-line sites
//! and is silent on 374 — and those 374 are exactly the ones where a blank line
//! carries meaning.
//!
//! # What "the gap" is
//!
//! Not the bytes between raw [`Block`] spans. `block_spans` returns spans that
//! are trailing-newline-inclusive (a list's span usually ends on one, after the
//! descendant union), so a raw-gap rule emits three newlines after every list.
//! The gap is defined against **content spans** instead — and the sequence of
//! content spans is a tiling of the file, so the bytes between two of them are
//! whitespace *by the partition*, not by inspection: a non-whitespace byte
//! between two content spans would lie in no span, which
//! [`crate::check_partition`] forbids. That is what [`normalize`] requires the
//! input partition for, and why it refuses to rewrite a file that fails it.
//!
//! A block's content span is its raw span
//!
//! 1. trimmed to its first and last non-whitespace byte, then
//! 2. **extended left** to the start of that line when the prefix is blank, and
//! 3. **extended right** to the end of the last line's content, before the line
//!    ending.
//!
//! Steps 2 and 3 are one repair, not two features: comrak's block sourcepos
//! omits bytes that belong to the block, and `block_spans` already compensates
//! for that class of defect with its descendant union.
//!
//! ## Step 2 is the indented-code fix
//!
//! comrak reports a top-level indented code block starting at **column 5**, so
//! its four-space indent belongs to no span and falls in the gap. Deleting it
//! turns the block into whatever its text says — in `30 notes/Nix, nix-shell.md`
//! (the corpus's only live exposure) a `CodeBlock` became a `List > Item >
//! Paragraph`. Three fixes were available:
//!
//! - *Exclude `CodeBlock` spans from tightening.* **Refuted on the merits**: the
//!   indent is outside the raw span before any tightening happens, so this does
//!   not fix the case at all — and it would emit comrak's trailing-newline-
//!   inclusive raw end verbatim for exactly the blocks whose trailing
//!   whitespace is content.
//! - *Refuse any gap whose deleted bytes hold four or more leading spaces.* A
//!   detector, not a repair: the file stays permanently outside the normal
//!   form, the rule's scope quietly becomes "top-level gaps except near
//!   indented code", and it over-refuses — a blank line padded with four spaces
//!   ahead of a fenced block is not an indented code block.
//! - *Extend the span left to column 1.* **Chosen.** It removes the cause
//!   rather than routing around it, and it is the same compensation
//!   `block_spans` already applies for the same parser defect.
//!
//! Generalizing step 2 to every block, rather than to code blocks only, costs
//! nothing and buys the 1–3-space case: an indent of one to three spaces is
//! legal, sets `marker_offset`/`fence_offset`, and is likewise outside the
//! block's sourcepos. Under a code-block-only fix those indents would be
//! deleted — render-identical, attribute-changing, and refused by the oracle
//! for no gain. Under the general rule they survive.
//!
//! ## Step 3 keeps trailing whitespace out of the gap
//!
//! Trimming a span to its last non-whitespace byte also eats trailing spaces on
//! its last **content** line, which is harmless for a paragraph and fatal for an
//! indented code block, whose literal is `"code   \n"`. Extending back to the
//! line's content end leaves those bytes inside the span, where they are copied
//! verbatim like every other byte a span covers.
//!
//! # The guard
//!
//! Every rewrite is checked with [`crate::structure`], and [`Normalization`]
//! hands out its bytes only through [`Normalization::accepted`], which returns
//! `None` unless the input partitioned and the re-parse is structurally
//! equivalent. The partition oracle cannot serve here — it passed on 167 of 167
//! synthetic documents this rewrite destroyed — and the shapes it misses are
//! live: `tests/normalize.rs` pins a leading `---` promoted into front matter
//! and a link reference definition deleted from the render, both of which
//! partition cleanly and both of which this refuses.

use crate::print::{Block, PartitionReport, block_spans, check_partition, is_ws};
use crate::span::{LineIndex, PosError};
use crate::structure::{StructureDiff, structure_of};

/// One gap the rewrite would change, for reporting. `old` is what the source
/// holds there; `new` is the normal form's separator.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GapChange {
    /// 1-based line the gap starts on.
    pub line: usize,
    /// Byte offset the gap starts at.
    pub start: usize,
    /// Kind of the block before the gap; `"<bof>"` at the head of the file.
    pub prev: &'static str,
    /// Kind of the block after the gap; `"<eof>"` at the tail.
    pub next: &'static str,
    pub old: String,
    pub new: &'static str,
}

/// A candidate normalization and everything needed to decide whether to take
/// it. Construct with [`normalize`]; read the bytes with
/// [`Normalization::accepted`].
#[derive(Debug, Clone)]
pub struct Normalization {
    /// The input's partition verdict. When this fails, no rewrite is attempted
    /// and `output` is the source unchanged — the gap definition is unsound
    /// without it.
    pub input_partition: PartitionReport,
    /// The candidate bytes. Present even when refused, so a caller can report
    /// *what* would have happened.
    pub output: String,
    /// Gaps examined, changed or not — head and tail included.
    pub gaps_considered: usize,
    /// Gaps the rewrite would change.
    pub gaps: Vec<GapChange>,
    /// `None` when the re-parse is structurally equivalent; otherwise why not.
    pub structure: Option<StructureDiff>,
    /// Whether the *output* still satisfies the partition oracle. Recorded, not
    /// relied on: it holds even for outputs whose parse the rewrite destroyed,
    /// which is precisely why it cannot be the guard. `None` when the output's
    /// sourcepos did not convert.
    pub output_partitions: Option<bool>,
}

impl Normalization {
    /// Whether the candidate differs from the input at all.
    pub fn changed(&self) -> bool {
        !self.gaps.is_empty()
    }

    /// The normalized bytes, or `None` when they must not be used: the input
    /// failed the partition, or the rewrite changed the parse. This is the only
    /// accessor that clears the guard, so a caller cannot take the bytes
    /// without it.
    pub fn accepted(&self) -> Option<&str> {
        (self.input_partition.is_partition() && self.structure.is_none()).then_some(&*self.output)
    }
}

/// The separator the normal form puts *before* a block, as a function of the
/// preceding block's kind (`None` at the head of the file).
fn separator(prev: Option<&str>) -> &'static str {
    match prev {
        // The head of the file, and the bytes after a BOM, which comrak counts
        // in its columns but assigns to no node.
        None | Some("bom") => "",
        // Front matter takes one blank line like any other block. The arm is
        // written out rather than folded into the fallback because this is the
        // one place someone would reinstate the withdrawn `"\n"` — no blank
        // line after front matter — and doing so rewrites 988 of 1052 corpus
        // files for a cosmetic preference.
        Some("frontmatter") => "\n\n",
        Some(_) => "\n\n",
    }
}

/// Whitespace that can sit *within* a line: space, tab, form feed. Excludes the
/// line endings, which is what makes "extend to this line's start/end" a
/// single-line operation.
fn is_inline_ws(b: u8) -> bool {
    b == b' ' || b == b'\t' || b == 0x0c
}

/// A block's content span: raw span trimmed to content, then extended to its
/// first line's start and its last line's content end where those bytes are
/// blank. `floor` and `ceil` clamp the extensions to the neighbouring blocks so
/// this can never manufacture an overlap (a BOM block, whose successor starts
/// on the same line, is the case that needs it).
///
/// `None` for a span holding no content byte; its bytes fall into the
/// surrounding gap.
fn content_span(
    source: &str,
    idx: &LineIndex,
    block: &Block,
    floor: usize,
    ceil: usize,
) -> Option<(usize, usize)> {
    let bytes = source.as_bytes();
    let end = block.end.min(source.len());
    let start = block.start.min(end);
    let first = (start..end).find(|&i| !is_ws(bytes[i]))?;
    let last = (start..end).rev().find(|&i| !is_ws(bytes[i]))? + 1;

    let line_start = idx
        .line_start(idx.position_of(first).0)
        .filter(|&ls| ls >= floor && source[ls..first].bytes().all(is_inline_ws))
        .unwrap_or(first);

    let mut line_end = idx
        .line_range(idx.position_of(last - 1).0)
        .map(|(_, e)| e)
        .unwrap_or(last);
    while line_end > last && matches!(bytes[line_end - 1], b'\n' | b'\r') {
        line_end -= 1;
    }
    if line_end > ceil || !source[last..line_end].bytes().all(is_inline_ws) {
        line_end = last;
    }

    Some((line_start, line_end))
}

/// The content spans of `blocks`, in source order, dropping any block with no
/// content byte.
fn content_spans(source: &str, blocks: &[Block]) -> Vec<(usize, usize, &'static str)> {
    let idx = LineIndex::new(source);
    let mut spans = Vec::with_capacity(blocks.len());
    let mut floor = 0usize;
    for (i, block) in blocks.iter().enumerate() {
        let ceil = blocks
            .get(i + 1)
            .map(|next| next.start)
            .unwrap_or(source.len());
        if let Some((start, end)) = content_span(source, &idx, block, floor, ceil) {
            spans.push((start, end, block.kind));
            floor = end;
        }
    }
    spans
}

/// Emit `separator + source[content span]` for each block in order. Every byte
/// inside a content span is copied verbatim; only the separators are
/// synthesized.
fn rewrite(source: &str, blocks: &[Block]) -> (String, Vec<GapChange>, usize) {
    let idx = LineIndex::new(source);
    let mut out = String::with_capacity(source.len());
    let mut gaps = Vec::new();
    let mut considered = 0usize;
    let mut cursor = 0usize;
    let mut prev: Option<&'static str> = None;

    let record =
        |gaps: &mut Vec<GapChange>, at: usize, old: &str, new: &'static str, prev, next| {
            if old != new {
                gaps.push(GapChange {
                    line: idx.position_of(at).0,
                    start: at,
                    prev,
                    next,
                    old: old.to_string(),
                    new,
                });
            }
        };

    for &(start, end, kind) in &content_spans(source, blocks) {
        let new = separator(prev);
        considered += 1;
        record(
            &mut gaps,
            cursor,
            &source[cursor..start],
            new,
            prev.unwrap_or("<bof>"),
            kind,
        );
        out.push_str(new);
        out.push_str(&source[start..end]);
        cursor = end;
        prev = Some(kind);
    }

    // The tail. A file with no block at all — empty, or whitespace only — gets
    // `""`, so a 0-byte file stays 0 bytes rather than gaining a newline.
    let new = if prev.is_some() { "\n" } else { "" };
    considered += 1;
    record(
        &mut gaps,
        cursor,
        &source[cursor..],
        new,
        prev.unwrap_or("<bof>"),
        "<eof>",
    );
    out.push_str(new);

    (out, gaps, considered)
}

/// Compute the blank-line normal form of `source` and check it.
///
/// Writes nothing and decides nothing: the result carries the candidate bytes,
/// the gaps that would change, and the guard's verdict.
/// [`Normalization::accepted`] is the only way to get bytes that cleared it.
///
/// `Err` carries every sourcepos that does not name a byte range in `source`,
/// exactly as [`crate::partition`] does.
pub fn normalize(source: &str, opts: &mdstruct::Options) -> Result<Normalization, Vec<PosError>> {
    let arena = comrak::Arena::new();
    let blocks = crate::parse_with(&arena, source, opts, |root| block_spans(root, source))?;
    let input_partition = check_partition(source, &blocks);

    // Without the partition the gap is not definable: an unclaimed content byte
    // would sit between two content spans and be deleted as if it were
    // whitespace. Refuse rather than guess.
    if !input_partition.is_partition() {
        return Ok(Normalization {
            input_partition,
            output: source.to_string(),
            gaps_considered: 0,
            gaps: Vec::new(),
            structure: None,
            output_partitions: None,
        });
    }

    let (output, gaps, gaps_considered) = rewrite(source, &blocks);
    let structure = structure_of(source, opts).diff(&structure_of(&output, opts));

    let out_arena = comrak::Arena::new();
    let output_partitions = crate::parse_with(&out_arena, &output, opts, |root| {
        block_spans(root, &output)
            .map(|b| check_partition(&output, &b).is_partition())
            .ok()
    });

    Ok(Normalization {
        input_partition,
        output,
        gaps_considered,
        gaps,
        structure,
        output_partitions,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn norm(source: &str) -> Normalization {
        normalize(source, &mdstruct::Options::default()).expect("spans convert")
    }

    #[test]
    fn one_blank_line_between_top_level_blocks() {
        let n = norm("# H\npara\n\n\n\nmore\n");
        assert_eq!(n.accepted(), Some("# H\n\npara\n\nmore\n"));
    }

    #[test]
    fn an_empty_file_stays_empty() {
        let n = norm("");
        assert_eq!(n.accepted(), Some(""));
        assert!(!n.changed());
    }

    #[test]
    fn a_whitespace_only_file_becomes_empty() {
        // No block to anchor a tail newline on, so the tail rule emits "".
        assert_eq!(norm("\n\n   \n").accepted(), Some(""));
    }

    #[test]
    fn a_bom_is_not_followed_by_a_blank_line() {
        let n = norm("\u{feff}# H\n");
        assert_eq!(n.accepted(), Some("\u{feff}# H\n"));
        assert!(!n.changed());
    }

    #[test]
    fn the_separator_before_the_first_block_is_empty() {
        assert_eq!(norm("\n\n# H\n").accepted(), Some("# H\n"));
    }
}
