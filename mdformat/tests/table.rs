//! Table padding: the properties the rewrite claims, and the corpus specimens
//! that decide its open questions.
//!
//! Every fixture is an embedded byte literal, for the same reason
//! `negative_controls.rs`'s are: a specimen on disk is one `autoformat` pass
//! away from being rewritten into something that no longer reproduces the shape
//! under test — and the shapes here are *made of whitespace*, so that risk is at
//! its worst.

use std::collections::{BTreeMap, BTreeSet};

use comrak::Arena;
use comrak::nodes::NodeValue;
use mdformat::table::whitespace_violation;
use mdformat::{PadViolationKind, Padding, SkipReason, pad};

fn opts() -> mdstruct::Options {
    mdstruct::Options::default()
}

fn utf8(bytes: &[u8]) -> &str {
    std::str::from_utf8(bytes).expect("fixtures are UTF-8")
}

fn padded(source: &str) -> Padding {
    pad(source, &opts()).expect("spans convert")
}

fn accept(source: &str) -> String {
    let p = padded(source);
    match p.accepted() {
        Some(out) => out.to_string(),
        None => panic!(
            "padding was refused: structure={:?} violation={:?}",
            p.structure.as_ref().map(|d| d.to_string()),
            p.violation.as_ref().map(|v| v.to_string())
        ),
    }
}

/// The claim the whole design rests on: a `TableCell`'s sourcepos names the
/// cell's **source** bytes, escapes intact — unlike the inline nodes beneath it,
/// which comrak shifts one byte left per preceding `\|` because it unescapes
/// before inline parsing.
///
/// If this ever stopped holding, measuring a cell's width from its source would
/// silently measure the wrong bytes, and no oracle here would notice — the
/// width is the transformation's own choice. So it is pinned against a real
/// parse rather than assumed.
#[test]
fn a_table_cells_sourcepos_is_byte_exact_with_escapes_intact() {
    let src = utf8(b"| a \\| b | c |\n| --- | --- |\n| x\\|y | z |\n");
    let arena = Arena::new();
    let (cells, inline) = mdformat::parse_with(&arena, src, &opts(), |root| {
        let idx = mdformat::LineIndex::new(src);
        let mut cells = Vec::new();
        let mut inline = Vec::new();
        for node in root.descendants() {
            let sp = node.data.borrow().sourcepos;
            match &node.data.borrow().value {
                NodeValue::TableCell => {
                    let (s, e) = idx.byte_span("tableCell", sp).expect("converts");
                    cells.push(src[s..e].to_string());
                }
                NodeValue::Text(t) => inline.push((t.to_string(), sp.start.column)),
                _ => {}
            }
        }
        (cells, inline)
    });

    assert_eq!(
        cells,
        vec![" a \\| b ", " c ", " x\\|y ", " z "],
        "cell sourcepos must slice the source verbatim, backslash included"
    );
    // The counterpart, and the reason this transformation reads cells and never
    // inlines: the text node inside the first cell has already been unescaped,
    // and its column no longer indexes the bytes on the line.
    assert_eq!(inline[0], ("a | b".to_string(), 3));
    assert_eq!(
        &src[2..7],
        "a \\| ",
        "the text node's own span slices five bytes that are not its text"
    );
}

/// The corpus's only alignment specimen (`20 cards/Faster CRDTs.md`), padded by
/// hand: a left-aligned first column and two right-aligned ones, whose cells are
/// padded on the **left**. The rewrite must reproduce it byte for byte, which is
/// simultaneously a fixpoint claim and the strongest available evidence that the
/// width measure, the minimum width, the alignment side, and the delimiter's
/// colon placement all match what a human wrote.
#[test]
fn the_corpus_alignment_specimen_is_reproduced_byte_for_byte() {
    let src = utf8(
        b"| Test                            | Time taken | RAM usage |\n\
          | :------------------------------ | ---------: | --------: |\n\
          | **automerge (v1.0.0-preview2)** |       291s |    880 MB |\n\
          | _Plain string edits in JS_      |      0.61s |    0.1 MB |\n",
    );
    let p = padded(src);
    assert_eq!(p.accepted(), Some(src));
    assert!(!p.changed(), "the specimen is already in the normal form");
    assert_eq!(p.tables_seen, 1);
    assert_eq!(p.tables_changed, 0);
}

/// The same table with every cell squeezed to one space: padding must rebuild
/// exactly the specimen above. This is the causal control for the test before
/// it — that one shows the normal form is a fixpoint, this one shows the normal
/// form is *reachable*, and together they show the two are the same bytes.
#[test]
fn squeezing_the_alignment_specimen_and_repadding_restores_it() {
    let squeezed = utf8(
        b"| Test | Time taken | RAM usage |\n\
          | :-- | --: | --: |\n\
          | **automerge (v1.0.0-preview2)** | 291s | 880 MB |\n\
          | _Plain string edits in JS_ | 0.61s | 0.1 MB |\n",
    );
    let expected = utf8(
        b"| Test                            | Time taken | RAM usage |\n\
          | :------------------------------ | ---------: | --------: |\n\
          | **automerge (v1.0.0-preview2)** |       291s |    880 MB |\n\
          | _Plain string edits in JS_      |      0.61s |    0.1 MB |\n",
    );
    assert_eq!(accept(squeezed), expected);
}

/// The corpus's only ragged table, reduced to its operative row
/// (`35 experiments/2026-07-30-mdstruct-span-passthrough.md`): a cell holding an
/// unescaped `|` **inside a code span**, which GFM splits on anyway. comrak
/// drops the excess cell from the tree and leaves its bytes on the line, so an
/// AST-driven padder would delete them.
///
/// The chosen policy is to decline the table whole. What matters is that the
/// choice is visible: the table comes back byte-identical and the skip is
/// reported, rather than the rewrite quietly doing something to it.
#[test]
fn the_corpus_ragged_specimen_is_declined_and_left_verbatim() {
    let src = utf8(
        b"| Term | Definition |\n\
          | --- | --- |\n\
          | **Claim** | The falsifiable predicate under test. |\n\
          | Escaped-pipe shift | comrak unescaping `\\|` to `|` before inline parsing. |\n",
    );

    // Pin the parser behaviour this policy exists for, so a comrak release that
    // changes it shows up here as a failure to explain rather than as silence.
    let arena = Arena::new();
    let counts = mdformat::parse_with(&arena, src, &opts(), |root| {
        root.descendants()
            .filter(|n| matches!(n.data.borrow().value, NodeValue::TableRow(_)))
            .map(|r| r.children().count())
            .collect::<Vec<_>>()
    });
    assert_eq!(
        counts,
        vec![2, 2, 2],
        "comrak reports two cells for the last row even though it has three"
    );

    let p = padded(src);
    assert_eq!(p.accepted(), Some(src), "the table must come back verbatim");
    assert_eq!(p.tables_seen, 1);
    assert_eq!(p.tables_changed, 0);
    assert!(matches!(
        p.skipped.as_slice(),
        [s] if matches!(s.reason, SkipReason::RaggedRow { line: 4, .. })
    ));
}

/// The other direction of raggedness, which comrak hides the opposite way: a
/// short row gains a phantom cell whose sourcepos is the row's trailing pipe.
#[test]
fn a_short_row_is_declined_too_and_comrak_puts_its_phantom_cell_on_the_pipe() {
    let src = utf8(b"| a | b | c |\n| --- | --- | --- |\n| 1 | 2 |\n");
    let arena = Arena::new();
    let phantom = mdformat::parse_with(&arena, src, &opts(), |root| {
        let idx = mdformat::LineIndex::new(src);
        let row = root
            .descendants()
            .filter(|n| matches!(n.data.borrow().value, NodeValue::TableRow(_)))
            .last()
            .expect("a body row");
        let last = row.children().last().expect("a cell");
        let sp = last.data.borrow().sourcepos;
        let (s, e) = idx.byte_span("tableCell", sp).expect("converts");
        src[s..e].to_string()
    });
    assert_eq!(phantom, "|", "the third cell's bytes ARE the trailing pipe");

    let p = padded(src);
    assert_eq!(p.accepted(), Some(src));
    assert!(matches!(
        p.skipped.as_slice(),
        [s] if matches!(s.reason, SkipReason::RaggedRow { line: 3, .. })
    ));
}

/// A table whose delimiter row is the only thing that changes still passes the
/// oracle, because the delimiter's dash count is its one exemption.
#[test]
fn widening_only_the_delimiter_row_is_permitted() {
    let src = utf8(b"| aaaaa | bbbbb |\n| - | - |\n| ccccc | ddddd |\n");
    assert_eq!(
        accept(src),
        "| aaaaa | bbbbb |\n| ----- | ----- |\n| ccccc | ddddd |\n"
    );
}

/// Padding is idempotent: applying it to its own output changes nothing. A
/// width rule that read its own padding — measuring the raw cell instead of the
/// trimmed one — would fail here on the second pass and nowhere else.
#[test]
fn padding_is_idempotent() {
    for src in [
        utf8(b"| a | b |\n| --- | --- |\n| longer | x |\n"),
        utf8(b"| \xd0\x9a\xd0\xbb\xd1\x8e\xd1\x87 | b |\n| --- | --- |\n| x | y |\n"),
        utf8(b"| a | b | c |\n| :-- | --: | :-: |\n| xxxx | yyyy | zzzz |\n"),
        utf8(b"> | a | bb |\n> | --- | --- |\n> | ccc | d |\n"),
        utf8(b"| a\\|b | c |\n| --- | --- |\n| d | e |\n"),
    ] {
        let once = accept(src);
        let twice = accept(&once);
        assert_eq!(once, twice, "padding must be a fixpoint of itself: {src:?}");
    }
}

/// The rewrite is whitespace-only outside the delimiter rows, stated as a
/// property over the specimens rather than read off any one diff.
#[test]
fn no_non_whitespace_byte_moves_outside_a_delimiter_row() {
    for src in [
        utf8(b"| a | b |\n| --- | --- |\n| longer | x |\n"),
        utf8(b"text before\n\n| a | b |\n| --- | --- |\n| longer | x |\n\ntext after\n"),
        utf8(b"| a | b | c |\n| :-- | --: | :-: |\n| xxxx | yyyy | zzzz |\n"),
        utf8(b"> | a | bb |\n> | --- | --- |\n> | ccc | d |\n"),
    ] {
        let out = accept(src);
        let strip = |s: &str| {
            s.lines()
                .enumerate()
                // Every fixture here puts its delimiter on the second line of
                // its table; dropping *all* dash runs would weaken the check.
                .filter(|(i, l)| !(l.contains("--") && (*i == 1 || *i == 3)))
                .map(|(_, l)| l.replace([' ', '\t'], ""))
                .collect::<Vec<_>>()
        };
        assert_eq!(strip(src), strip(&out), "for {src:?}");
    }
}

/// The oracle is not vacuous. Hand it an "after" that changed a non-whitespace
/// byte on an ordinary line, and it must say so — otherwise the guard the
/// rewrite ships behind would pass on anything.
#[test]
fn the_whitespace_oracle_rejects_a_changed_content_byte() {
    let before = utf8(b"| a | b |\n| --- | --- |\n| 1 | 2 |\n");
    let after = utf8(b"| a | b |\n| --- | --- |\n| 1 | 9 |\n");
    let delims = BTreeMap::from([(2usize, 0usize)]);
    let rows = BTreeSet::from([1usize, 3]);
    let v = whitespace_violation(before, after, &delims, &rows).expect("must reject");
    assert_eq!(v.kind, PadViolationKind::ContentBytes);
    assert_eq!(v.line, 3);
}

/// And it distinguishes the delimiter row's dash count, which is exempt, from
/// its colons, which are not.
#[test]
fn the_whitespace_oracle_exempts_dashes_but_not_colons() {
    let before = utf8(b"| a | b |\n| :-- | --- |\n| 1 | 2 |\n");
    let delims = BTreeMap::from([(2usize, 0usize)]);
    let rows = BTreeSet::from([1usize, 3]);

    let widened = utf8(b"| a | b |\n| :-------- | --------- |\n| 1 | 2 |\n");
    assert_eq!(
        whitespace_violation(before, widened, &delims, &rows),
        None,
        "a longer dash run is the one change this rewrite is for"
    );

    let recoloured = utf8(b"| a | b |\n| --- | --- |\n| 1 | 2 |\n");
    let v = whitespace_violation(before, recoloured, &delims, &rows).expect("must reject");
    assert_eq!(v.kind, PadViolationKind::DelimiterMarkers);
}

/// A cell whose interior spacing changed keeps its non-whitespace bytes, so the
/// per-line check cannot see it. The cell check is what does, and this is the
/// specimen that separates the two.
#[test]
fn the_cell_oracle_catches_what_the_line_check_cannot() {
    let before = utf8(b"| a  b | c |\n| --- | --- |\n| 1 | 2 |\n");
    let after = utf8(b"| a b  | c |\n| --- | --- |\n| 1 | 2 |\n");
    let delims = BTreeMap::from([(2usize, 0usize)]);

    // Without the row registered, only the non-whitespace byte sequence is
    // compared — and it is unchanged, so nothing is reported.
    assert_eq!(
        whitespace_violation(before, after, &delims, &BTreeSet::new()),
        None,
        "the line check is provably blind to an interior space"
    );

    let rows = BTreeSet::from([1usize, 3]);
    let v = whitespace_violation(before, after, &delims, &rows).expect("must reject");
    assert_eq!(v.kind, PadViolationKind::CellContent);
    assert_eq!(v.line, 1);
}
