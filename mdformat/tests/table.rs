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
use comrak::nodes::{NodeValue, Sourcepos};
use mdformat::table::whitespace_violation;
use mdformat::{PadViolationKind, Padding, SkipReason, check, pad};

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
///
/// Its trailing column is right-aligned, so the exemption never reaches it and
/// the header-width delimiter rule never reaches it either: every column here,
/// delimiter included, is sized by the widest cell. That is what makes it the
/// one corpus table the exemption leaves standing.
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
    // The trailing column's cells are exempt from fill, but its delimiter run
    // still widens — to the width of the header above it, which here is the
    // same 5 the first column's computed width gives.
    let src = utf8(b"| aaaaa | bbbbb |\n| - | - |\n| ccccc | ddddd |\n");
    assert_eq!(
        accept(src),
        "| aaaaa | bbbbb |\n| ----- | ----- |\n| ccccc | ddddd |\n"
    );
}

/// The trailing-column exemption, stated over the four alignments it turns on.
///
/// A trailing column whose alignment is absent or left carries fill that
/// nothing reads: the only thing it separates the content from is the closing
/// pipe. A trailing column that is right- or center-aligned carries fill that
/// *is* the alignment, so it keeps it. Everything before the last column is
/// padded either way. Where the exemption takes the cell fill it also takes the
/// delimiter's width from the **header** rather than from the column, so the
/// dash run matches the cell printed directly above it.
#[test]
fn a_trailing_unaligned_column_is_left_unpadded() {
    let src = utf8(b"| Term | Definition |\n| --- | --- |\n| a | a long definition |\n");
    // `Definition` is 10 wide and the column is 17, so the dash run is 10.
    assert_eq!(
        accept(src),
        "| Term | Definition |\n| ---- | ---------- |\n| a    | a long definition |\n"
    );
}

#[test]
fn a_trailing_left_aligned_column_is_left_unpadded_too() {
    let src = utf8(b"| Term | Definition |\n| :--- | :--- |\n| a | a long definition |\n");
    // The colon survives on the same side, and the cell it opens is the width
    // of the header above it — colon included, so nine dashes follow.
    assert_eq!(
        accept(src),
        "| Term | Definition |\n| :--- | :--------- |\n| a    | a long definition |\n"
    );
}

#[test]
fn a_trailing_right_aligned_column_keeps_its_padding() {
    let src = utf8(b"| Term | Count |\n| --- | ---: |\n| a | 1 |\n");
    assert_eq!(
        accept(src),
        "| Term | Count |\n| ---- | ----: |\n| a    |     1 |\n"
    );
}

#[test]
fn a_trailing_center_aligned_column_keeps_its_padding() {
    let src = utf8(b"| Term | Count |\n| --- | :-: |\n| a | 1 |\n");
    assert_eq!(
        accept(src),
        "| Term | Count |\n| ---- | :---: |\n| a    |   1   |\n"
    );
}

/// A one-column table is all trailing column, so the exemption either takes the
/// whole table or none of it. Unaligned, cells are left unpadded and an
/// already-3-wide delimiter is a fixpoint; right-aligned, every cell is.
#[test]
fn a_single_column_table_is_all_trailing_column() {
    let bare = utf8(b"| Key |\n| --- |\n| a |\n");
    let p = padded(bare);
    assert_eq!(p.accepted(), Some(bare));
    assert!(!p.changed(), "there is no cell left to pad");
    assert_eq!(p.tables_seen, 1);
    assert_eq!(p.tables_changed, 0);

    let aligned = utf8(b"| Only |\n| ---: |\n| a |\n");
    assert_eq!(accept(aligned), "| Only |\n| ---: |\n|    a |\n");
}

/// **The counter-evidence, pinned.** The exemption is not free: a table padded
/// by hand in the shape the uncapped padder produced — trailing column filled
/// to its width — is no longer a fixpoint. It loses the trailing cell fill
/// *and* the part of the delimiter run that reached past the header: `value `
/// gives back its one space, and the six dashes under it come back to the five
/// `value` occupies.
///
/// This is the shape most of the corpus's hand-padded tables are in, so this
/// test is the specimen behind "tables that were byte-exact fixpoints now
/// change". It is asserted here rather than left to a dry run, because the cost
/// of the rule should fail loudly if anyone tries to argue it away.
#[test]
fn a_hand_padded_trailing_column_loses_its_padding() {
    let src = utf8(b"| key | value  |\n| --- | ------ |\n| a   | longer |\n");
    let p = padded(src);
    assert!(
        p.changed(),
        "the uncapped padder's own output is no longer a fixpoint"
    );
    assert_eq!(
        p.accepted(),
        Some("| key | value |\n| --- | ----- |\n| a   | longer |\n")
    );
    assert_eq!(p.tables_changed, 1);
}

/// **The rule this change is for, pinned directly.** A trailing header cell
/// far narrower than the widest body cell in its column: the dash run follows
/// the header, not the column.
///
/// The shape is `home/agents/skills/basecamp/SKILL.md`'s reduced to its
/// operative columns — a `Format` header over a 95-wide body cell, where the
/// old rule put 95 dashes under a 6-wide word and made the delimiter line more
/// than twice the header line.
#[test]
fn the_trailing_delimiter_follows_the_header_and_not_the_column() {
    let src = utf8(
        b"| Command | Format |\n\
          | --- | --- |\n\
          | schedule | a long specification of the schedule entry format |\n",
    );
    let out = accept(src);
    assert_eq!(
        out,
        "| Command  | Format |\n\
         | -------- | ------ |\n\
         | schedule | a long specification of the schedule entry format |\n"
    );
    let widths: Vec<usize> = out.lines().map(|l| l.chars().count()).collect();
    assert_eq!(
        widths[1], widths[0],
        "the delimiter line must be as wide as the header line, not the body"
    );
}

/// The floor still wins under the new rule: a trailing header narrower than
/// three leaves three dashes, so `---` (and every alignment marker pair) fits.
#[test]
fn a_trailing_header_narrower_than_three_still_gets_three_dashes() {
    let src = utf8(b"| Key | x |\n| --- | - |\n| a | a much longer cell |\n");
    assert_eq!(
        accept(src),
        "| Key | x |\n| --- | --- |\n| a   | a much longer cell |\n"
    );

    // And with a colon, where the floor is what keeps the marker renderable.
    let aligned = utf8(b"| Key | x |\n| --- | :-- |\n| a | a much longer cell |\n");
    assert_eq!(
        accept(aligned),
        "| Key | x |\n| --- | :-- |\n| a   | a much longer cell |\n"
    );
}

/// The claim that makes the exemption cheap: it never narrows a table, and it
/// never widens one either. The widest line is the row holding the widest
/// trailing cell, and that cell had no fill to lose — so the maximum line width
/// is identical with the exemption and without it, and only the shorter rows
/// get shorter.
#[test]
fn the_exemption_leaves_the_widest_line_where_the_uncapped_form_had_it() {
    let src = utf8(b"| key | value |\n| --- | --- |\n| a | longer |\n| bb | x |\n");
    let uncapped =
        utf8(b"| key | value  |\n| --- | ------ |\n| a   | longer |\n| bb  | x      |\n");
    let widest = |s: &str| s.lines().map(|l| l.chars().count()).max().unwrap_or(0);
    let out = accept(src);
    assert_eq!(
        widest(&out),
        widest(uncapped),
        "the exemption must not change the table's widest line"
    );
    assert!(
        out.len() < uncapped.len(),
        "but it must remove bytes from the shorter rows"
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
        // The exemption's own shapes: a trailing column that is dropped from
        // cell padding must not be re-padded on the second pass, and its
        // delimiter run — sized to the header above it — must be a fixpoint of
        // itself.
        utf8(b"| key | value  |\n| --- | ------ |\n| a   | longer |\n"),
        utf8(b"| Term | Definition |\n| :--- | :--- |\n| a | a long definition |\n"),
        utf8(b"| Only |\n| --- |\n| a |\n"),
        utf8(b"| Only |\n| ---: |\n| a |\n"),
        utf8(b"a | bb\n--- | ---\nccc | d\n"),
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

/// **The whole-document guards, and the claim that nothing reaches them.**
///
/// `pad` carries two verdicts a caller can read apart: `skipped`, one table the
/// rewrite declined, and `structure`/`violation`, the whole document refused.
/// Every declining fixture in this crate exercises the first. This one states
/// what could not be turned into a fixture: **no input reaches the second**.
///
/// That is a claim about reachability, and it is asserted rather than assumed
/// because both readings of the silence are live. Either the guards are silent
/// because the rewrite is faithful — the reading this test pins — or they are
/// silent because they are wired to something that cannot move, which is the
/// vacuous-guard failure this crate has shipped three times. The refutation of
/// the second reading lives in `table_negative_controls.rs`, which hands the
/// same oracles hand-built wrong padders and gets a refusal every time. So the
/// guards can fail; nothing here makes them.
///
/// And the distance between the two readings is one character class, measured:
/// trimming a cell with `trim()` instead of `trim_matches(' ')` eats the tab in
/// `tab-at-cell-edge`, the parse changes, and the rule refuses the whole
/// document — 182 of the crate's 183 tests still pass, and the one that fails is
/// this one. A padder that starts declining every document holding a tab in a
/// cell is a formatter that quietly stops formatting, and until this fixture
/// nothing in the crate would have said so.
///
/// The specimens are the shapes a whole-document refusal would most plausibly
/// come from: carriage returns the pipeline would have removed but `check` hands
/// this rule intact, whitespace that is not a space, escapes at a cell edge,
/// containers, tables with no outer pipes, and the two raggedness directions.
/// Each is either padded, or declined **one table at a time** — which is the
/// distinction the report makes and the bytes do not, since a document left
/// verbatim by an exemption and one left verbatim by a refusal are the same
/// document.
#[test]
fn every_refusal_this_rule_makes_is_one_table_and_not_the_document() {
    // (name, source). A `\r` here is deliberate: `check` runs every rule on the
    // same input, so this rule sees the endings the pipeline would have fixed.
    let specimens: &[(&str, &[u8])] = &[
        ("crlf", b"| a | b |\r\n| - | - |\r\n| 1 | 2 |\r\n"),
        ("lone-cr", b"| a | b |\r| - | - |\r| 1 | 2 |\r"),
        ("tab-in-cell", b"| a\tx | b |\n| - | - |\n| 1 | 2 |\n"),
        ("tab-at-cell-edge", b"|\ta | b |\n| - | - |\n| 1 | 2 |\n"),
        (
            "no-break-space",
            b"| \xC2\xA0a | b |\n| - | - |\n| 1 | 2 |\n",
        ),
        ("escaped-pipe", b"| a \\| b | c |\n| - | - |\n| 1 | 2 |\n"),
        (
            "escaped-backslash",
            b"| a\\\\ | b |\n| - | - |\n| 1 | 2 |\n",
        ),
        (
            "escaped-leading-pipe",
            b"\\| a | b |\n| - | - |\n| 1 | 2 |\n",
        ),
        ("no-outer-pipes", b"a | b\n- | -\n1 | 2\n"),
        (
            "in-a-block-quote",
            b"> | a | b |\n> | - | - |\n> | 1 | 2 |\n",
        ),
        ("lazy-continuation", b"> | a | b |\n> | - | - |\nlazy\n"),
        ("in-a-list-item", b"- item\n\n  | a | b |\n  | - | - |\n"),
        ("empty-cells", b"|  |  |\n| - | - |\n|  |  |\n"),
        ("aligned", b"| a | b |\n| :-: | --: |\n| 1 | 2 |\n"),
        ("trailing-spaces", b"| a | b |  \n| - | - |\n| 1 | 2 |  \n"),
        ("backslash-at-eol", b"| a | b\\ |\n| - | - |\n| 1 | 2 |\n"),
        ("code-span-pipe", b"| `a|b` | c |\n| - | - |\n| 1 | 2 |\n"),
        ("three-space-indent", b"   | a | b |\n   | - | - |\n"),
        (
            "two-tables",
            b"| a | b |\n| - | - |\n\n| c | d |\n| - | - |\n",
        ),
        ("long-row", b"| a | b |\n| - | - |\n| 1 | 2 | 3 |\n"),
        ("short-row", b"| a | b |\n| - | - |\n| 1 |\n"),
    ];

    let (mut padded_some, mut skipped_some) = (0usize, 0usize);
    for (name, input) in specimens {
        let src = utf8(input);
        let p = padded(src);
        assert!(
            p.structure.is_none(),
            "{name}: padding changed the parse, which no input was thought to \
             do: {:?}",
            p.structure.as_ref().map(|d| d.to_string())
        );
        assert!(
            p.violation.is_none(),
            "{name}: padding moved more than whitespace, which no input was \
             thought to do: {:?}",
            p.violation.as_ref().map(|v| v.to_string())
        );
        assert_eq!(
            p.accepted(),
            Some(&*p.output),
            "{name}: the bytes must be available, since no guard refused them"
        );
        padded_some += usize::from(p.changed());
        skipped_some += usize::from(!p.skipped.is_empty());

        // And the same verdict where a caller reads it: one exemption per
        // declined table, and no declination of the document.
        let c = check(src, &opts()).expect("spans convert");
        let r = c
            .rules
            .iter()
            .find(|r| r.rule == "tables")
            .expect("the table rule is in RULES");
        assert!(
            r.declined.is_none(),
            "{name}: the rule declined the whole document: {:?}",
            r.declined
        );
        assert_eq!(
            r.exempt.len(),
            p.skipped.len(),
            "{name}: every declined table must reach the report"
        );
        assert_eq!(
            r.is_normal(),
            !p.changed(),
            "{name}: the predicate must agree with the rewrite"
        );
    }

    // The battery is not vacuous in either direction: it holds shapes the rule
    // pads and shapes it declines, so the silence above is a measurement over
    // both branches rather than over an inert list.
    assert!(
        padded_some >= 12,
        "only {padded_some} specimens were padded"
    );
    assert!(
        skipped_some >= 3,
        "only {skipped_some} specimens exercised the per-table exemption"
    );
}

/// Every node's sourcepos in a document, root excluded — the root's own start
/// column is 1 whatever precedes it, so it is the one node the invariant below
/// does not describe.
fn positions(src: &str) -> Vec<(&'static str, Sourcepos)> {
    let arena = Arena::new();
    mdformat::parse_with(&arena, src, &opts(), |root| {
        root.descendants()
            .skip(1)
            .map(|n| {
                let d = n.data.borrow();
                (mdformat::block_kind(&d.value), d.sourcepos)
            })
            .collect()
    })
}

/// The boundary of the byte order mark's reach, pinned in both directions.
///
/// A mark occupies three bytes of line 1 and of no other line. So a marked
/// document's sourcepos must equal the unmarked document's with three added to
/// every column reported **on line 1**, and nothing added anywhere else. That
/// is the whole invariant, and it is what the crate's spans, widths and splices
/// all rest on.
///
/// comrak breaks it inside a table that opens on line 1: it anchors every row
/// and every cell at the table's line-1 opening offset — the mark's bytes
/// included — plus their offset within the row, so a body row two lines down is
/// reported three columns right of where it is, and this specimen's last cell
/// ran past the end of the file. [`mdformat::anchor`] repairs that by
/// re-anchoring each row at its own line's opening; this holds the repair to the
/// boundary from the mark's side, where the carry is a known three bytes and the
/// arithmetic can be checked by hand.
///
/// Both directions carry weight, and each part of the boundary has a specimen
/// here that reddens when it is dropped:
///
/// - Repairing too little leaves a later line three columns right.
/// - Repairing a column on the table's **opening line** moves one where the
///   mark's bytes really do sit. The `table-on-line-1` specimen catches that.
/// - Repairing a `Table`'s or a `TableRow`'s own `end` moves one comrak measures
///   from the line it lands on rather than from the anchor. Two columns and two
///   body rows are what make that visible; a one-row or one-column table cannot
///   separate it from the start columns.
/// - Repairing a table that opens on a **later** line, where the mark is on no
///   line the table spans, must be the identity. The `table-after-a-paragraph`
///   specimen is there for that alone.
#[test]
fn a_byte_order_mark_shifts_only_line_one_columns_inside_a_table() {
    // (name, the unmarked document). Each is prefixed with the mark to make the
    // marked half, so the two halves cannot drift apart.
    let specimens: &[(&str, &[u8])] = &[
        (
            "table-on-line-1",
            b"| abc | defg |\n| --- | --- |\n| 1 | 2 |\n| 33 | 44 |\n",
        ),
        (
            "table-after-a-paragraph",
            b"intro\n\n| abc | defg |\n| --- | --- |\n| 1 | 2 |\n| 33 | 44 |\n",
        ),
    ];

    let mark = "\u{feff}".len();
    let shift = |line: usize| if line == 1 { mark } else { 0 };
    for (name, body) in specimens {
        let bare = positions(utf8(body));
        let marked = positions(&format!("\u{feff}{}", utf8(body)));
        assert_eq!(
            bare.len(),
            marked.len(),
            "{name}: the mark must not change the tree, only where its nodes sit"
        );
        assert_eq!(
            bare.iter().filter(|(k, _)| *k == "tableRow").count(),
            3,
            "{name}: the specimen must carry a header row and two body rows"
        );

        for (i, ((kind, b), (_, m))) in bare.iter().zip(&marked).enumerate() {
            let want = Sourcepos::from((
                b.start.line,
                b.start.column + shift(b.start.line),
                b.end.line,
                b.end.column + shift(b.end.line),
            ));
            assert_eq!(
                *m, want,
                "{name}: node {i} ({kind}): the mark moved a column off line 1 \
                 — unmarked {b:?}, marked {m:?}"
            );
        }
    }
}
