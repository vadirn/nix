//! Deliberately wrong padders the structural oracle must **reject**.
//!
//! `tests/table.rs` asserts the real padder's output is structurally equivalent
//! to its input. That is only half a contract: an oracle that never fails passes
//! those tests too. These specimens pin the failure path, and each one is a
//! padder someone could plausibly write — not an arbitrary corruption.
//!
//! # Why these three, and not others
//!
//! A census of table padding found `src/structure.rs` too permissive in exactly
//! three places, and this file is the assertion that each is now closed:
//!
//! 1. a change to a **cell's content**, as opposed to the spaces around it,
//! 2. a **ragged row** gaining or losing a cell,
//! 3. a change to a **delimiter row's alignment markers**.
//!
//! Every test here follows the same shape: the real padder's output as the
//! passing control, one wrong padder's output as the failure, and the two
//! differing in exactly one respect. Where the tree signatures are *jointly
//! blind* — and for the ragged row they are — that blindness is asserted too,
//! so the reason the fourth signature exists cannot quietly stop being true.
//!
//! Fixtures are embedded byte literals, per `negative_controls.rs`.

use mdformat::{Structure, pad, structure_of};

fn opts() -> mdstruct::Options {
    mdstruct::Options::default()
}

fn utf8(bytes: &[u8]) -> &str {
    std::str::from_utf8(bytes).expect("fixtures are UTF-8")
}

fn structure(source: &str) -> Structure {
    structure_of(source, &opts())
}

/// The real padder's accepted output, which every test below uses as its
/// passing control.
fn correct(source: &str) -> String {
    pad(source, &opts())
        .expect("spans convert")
        .accepted()
        .expect("the real padder must clear its own guards")
        .to_string()
}

/// Assert the oracle rejects `wrong` as a rewrite of `source`, and that the
/// table signature is what did it.
fn rejected_by_the_table_signature(source: &str, wrong: &str) -> mdformat::StructureDiff {
    assert_eq!(
        structure(source).diff(&structure(&correct(source))),
        None,
        "the control must pass, or this test is not isolating the defect"
    );
    let diff = structure(source)
        .diff(&structure(wrong))
        .expect("the oracle was expected to reject this padder");
    assert!(
        !diff.tables_same,
        "the table signature must be what rejects it, got {diff}"
    );
    diff
}

/// **Wrong padder (a).** Pads correctly, then rebuilds each cell from its words
/// instead of copying its bytes — the mistake of reaching for
/// `split_whitespace().join(" ")` when a cell holds two consecutive spaces.
///
/// This one the HTML signature already catches, and the assertion below records
/// that: the tightening did not create the coverage, it made it specific enough
/// to name the cell.
#[test]
fn a_padder_that_rebuilds_a_cell_from_its_words_is_rejected() {
    let src = utf8(b"| key    name | value |\n| --- | --- |\n| a | b |\n");
    let wrong = utf8(b"| key name | value |\n| -------- | ----- |\n| a        | b     |\n");

    let diff = rejected_by_the_table_signature(src, wrong);
    assert!(
        !diff.html_same,
        "a cell's rendered text changed, so HTML must object too"
    );
}

/// **Wrong padder (b).** Drives itself from the AST's cell list, so on a row
/// that is *short* by one cell it materializes comrak's phantom cell — the one
/// whose sourcepos is the row's trailing pipe — into a real empty cell.
///
/// The tree cannot see this. Both documents parse to the same three
/// `TableCell` nodes with the same attributes and render to the same three
/// `<td>`s, so `kinds`, `rich` and `html` are **jointly blind**, and only the
/// source-derived table signature rejects it.
#[test]
fn a_padder_that_synthesizes_a_cell_on_a_short_row_is_rejected() {
    let src = utf8(b"| a | b | c |\n| --- | --- | --- |\n| 1 | 2 |\n");
    let wrong = utf8(b"| a   | b   | c   |\n| --- | --- | --- |\n| 1   | 2   |     |\n");

    let diff = rejected_by_the_table_signature(src, wrong);
    assert!(
        diff.kinds_same && diff.rich_same && diff.html_same,
        "the tree signatures were expected to be fooled, got {diff}"
    );
}

/// The same blindness, stated as its own claim so it fails on its own terms if
/// a comrak release ever starts modelling raggedness. This is the test
/// `src/structure.rs` names as the evidence for its fourth signature.
#[test]
fn the_tree_signatures_are_jointly_blind_to_a_synthesized_cell() {
    let short = utf8(b"| a | b | c |\n| --- | --- | --- |\n| 1 | 2 |\n");
    let filled = utf8(b"| a | b | c |\n| --- | --- | --- |\n| 1 | 2 |  |\n");
    let (s, f) = (structure(short), structure(filled));
    assert_eq!(s.kinds, f.kinds);
    assert_eq!(s.rich, f.rich);
    assert_eq!(s.html, f.html);
    assert_ne!(
        s.tables, f.tables,
        "the source-derived signature must be the one that separates them"
    );
}

/// **Wrong padder (c).** The same AST-driven padder meeting the *other*
/// direction of raggedness: a row with more cells than the table has columns.
/// comrak drops the excess from the tree and leaves its bytes on the line, so a
/// padder that re-emits the AST's cells **deletes content** — and the tree
/// signatures are blind to that too, because the tree never held the deleted
/// cell in the first place.
///
/// This is the shape the corpus actually contains
/// (`35 experiments/2026-07-30-mdstruct-span-passthrough.md`), which is why the
/// real padder declines the table rather than trusting the AST.
#[test]
fn a_padder_that_drops_a_long_rows_overflow_is_rejected() {
    let src = utf8(b"| a | b |\n| --- | --- |\n| 1 | 2 | 3 |\n");
    let wrong = utf8(b"| a   | b   |\n| --- | --- |\n| 1   | 2   |\n");

    let diff = rejected_by_the_table_signature(src, wrong);
    assert!(
        diff.kinds_same && diff.rich_same && diff.html_same,
        "content was deleted and the tree signatures were expected to be fooled, got {diff}"
    );
}

/// **Wrong padder (d).** Rebuilds the delimiter row from the column widths but
/// forgets to carry the alignment, so `:---` and `---:` come back as `---`.
///
/// `rich` catches this through `NodeTable::alignments`; the assertion records
/// that, and the table signature is asserted as well so the delimiter's colons
/// stay covered even for a rewrite that keeps the parsed alignment intact.
#[test]
fn a_padder_that_forgets_the_alignment_markers_is_rejected() {
    let src = utf8(b"| a | b | c |\n| :-- | --: | :-: |\n| xxxx | yyyy | zzzz |\n");
    let wrong = utf8(b"| a    | b    | c    |\n| ---- | ---- | ---- |\n| xxxx | yyyy | zzzz |\n");

    let diff = rejected_by_the_table_signature(src, wrong);
    assert!(
        !diff.rich_same && !diff.html_same,
        "dropping an alignment changes the parse and the render, got {diff}"
    );
}

/// The exemption the table signature must **keep**: widening a delimiter row's
/// dash run is the one byte change table padding exists to make, so it must not
/// register as a structural difference. Without this the oracle would refuse the
/// rewrite it is meant to gate.
#[test]
fn widening_a_delimiter_rows_dashes_is_not_a_structural_difference() {
    let narrow = utf8(b"| a | b |\n| :-- | --: |\n| longer | x |\n");
    let wide = utf8(b"| a | b |\n| :--------- | ------: |\n| longer | x |\n");
    assert_eq!(
        structure(narrow).diff(&structure(wide)),
        None,
        "the dash count is content this rewrite is defined to change"
    );
}

/// And the exemption is exactly that narrow: the *number* of delimiter cells is
/// still structure, so a padder that lost one is rejected even though every
/// byte it wrote is a dash.
#[test]
fn losing_a_delimiter_cell_is_still_a_structural_difference() {
    let src = utf8(b"| a | b |\n| --- | --- |\n| 1 | 2 |\n");
    let wrong = utf8(b"| a | b |\n| ------- |\n| 1 | 2 |\n");
    let diff = structure(src)
        .diff(&structure(wrong))
        .expect("the oracle was expected to reject this");
    assert!(!diff.tables_same, "got {diff}");
}
