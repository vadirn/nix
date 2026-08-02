//! Specimens the partition oracle must **reject**.
//!
//! `partition.rs` asserts the oracle passes on everything the vault holds. That
//! is only half a contract: an oracle that never fails passes those tests too,
//! so a regression that silently disabled checking would read as green. These
//! two specimens pin the failure path against a *real* parser defect rather
//! than an injected one, which is what
//! `partition.rs::shortening_every_span_by_one_byte_fails_the_partition`
//! already covers.
//!
//! Both also demonstrate the trap `print.rs`'s module docs describe: the
//! printer's output still equals its input, byte for byte, while content sits
//! in no span at all. Reassembly equality is satisfied by exactly the span
//! sets the oracle exists to refuse.
//!
//! Each specimen is an embedded byte literal, for the same reason the
//! `partition.rs` fixtures are: a specimen on disk is one `autoformat` pass
//! away from being rewritten into something that no longer reproduces the
//! defect.
//!
//! # Neither is dead weight
//!
//! Both shapes are documented in `print.rs` as the residual holes its two
//! workarounds leave open, and neither workaround can be widened without
//! widening the tolerance the oracle exists to withhold. Landing them as
//! *asserted* failures fixes the boundary: the day either shape starts
//! passing — a comrak release, a widened fill — a test fails and someone has
//! to say why.

use comrak::Arena;
use comrak::nodes::NodeValue;
use mdformat::{Block, Violation, block_spans, check_partition, reassemble};

fn spans(source: &str) -> Vec<Block> {
    let arena = Arena::new();
    let opts = mdstruct::Options::default();
    mdformat::parse_with(&arena, source, &opts, |root| {
        block_spans(root, source).unwrap_or_else(|e| panic!("sourcepos errors: {e:?}"))
    })
}

/// The single uncovered run of a report that has exactly one violation and it
/// is `Uncovered`. Panics otherwise, so a failure for the *wrong* reason is
/// never mistaken for the failure being asserted.
fn sole_uncovered<'a>(source: &'a str, blocks: &[Block]) -> &'a str {
    let report = check_partition(source, blocks);
    assert!(
        !report.is_partition(),
        "the oracle was expected to reject this specimen"
    );
    assert!(
        report.covered_content_bytes < report.content_bytes,
        "byte accounting should show the shortfall: {}/{}",
        report.covered_content_bytes,
        report.content_bytes
    );
    match report.violations.as_slice() {
        [Violation::Uncovered { start, end }] => &source[*start..*end],
        other => panic!("expected one Uncovered violation, got {other:#?}"),
    }
}

/// **Negative control (a).** `block_spans` repairs a container whose end
/// comrak truncated by unioning in its block descendants' ranges — but that
/// recovers the bytes only when some *later* descendant reports a correct end.
/// Put the indented code block in the LAST list item and follow the list with
/// a top-level block, and there is no later sibling to borrow a correct end
/// from: the item's own code block reports an empty range, the list's end
/// stops mid-line, and the code block's content lands in no span.
///
/// This is the minimal case that defeats the workaround, and the reason the
/// workaround is documented as a partial repair rather than a fix.
#[test]
fn an_indented_code_block_in_the_last_list_item_leaves_its_content_uncovered() {
    let src = b"1. first\n2. last item text\n\n        indented code\n        more code\n\ntail paragraph\n";
    let src = std::str::from_utf8(src).unwrap();

    // Pin the parser defect itself, so a comrak release that fixes it shows up
    // here as a failure to explain rather than as silence.
    let arena = Arena::new();
    let opts = mdstruct::Options::default();
    let (list_end, code_pos) = mdformat::parse_with(&arena, src, &opts, |root| {
        let list = root.first_child().expect("a list");
        let list_end = list.data.borrow().sourcepos.end;
        let code = list
            .descendants()
            .find(|n| matches!(n.data.borrow().value, NodeValue::CodeBlock(_)))
            .expect("an indented code block");
        (list_end, code.data.borrow().sourcepos)
    });
    assert_eq!(
        (code_pos.start.line, code_pos.start.column),
        (code_pos.end.line, code_pos.end.column),
        "comrak was expected to report the code block as an EMPTY range, got {code_pos:?}"
    );
    assert_eq!(
        (list_end.line, list_end.column),
        (4, 8),
        "comrak was expected to truncate the list's end onto the code block's first line"
    );

    let blocks = spans(src);
    assert_eq!(
        sole_uncovered(src, &blocks),
        "indented code\n        more code",
        "the code block's content must be what goes missing"
    );

    // The trap, on a real defect: the printer reproduces the file exactly
    // while 31 bytes of it belong to no block. Only the oracle notices.
    assert_eq!(
        reassemble(src, &blocks),
        src,
        "reassembly is boundary-insensitive and was expected to be fooled"
    );
}

/// The causal control for the test above. Same list, same indented code block,
/// same last item — with the trailing top-level paragraph removed. It passes.
/// The single differing factor is therefore the trailing block, which is what
/// forces comrak to close the code block by dedent and lose its range; with
/// the list at EOF, comrak reports the code block correctly and the union has
/// something true to work with.
#[test]
fn the_same_list_at_eof_passes_isolating_the_trailing_block_as_the_cause() {
    let src = b"- item one\n- last item:\n\n        code line one\n        code line two\n";
    let src = std::str::from_utf8(src).unwrap();

    let arena = Arena::new();
    let opts = mdstruct::Options::default();
    let code_pos = mdformat::parse_with(&arena, src, &opts, |root| {
        root.descendants()
            .find(|n| matches!(n.data.borrow().value, NodeValue::CodeBlock(_)))
            .expect("an indented code block")
            .data
            .borrow()
            .sourcepos
    });
    assert_ne!(
        (code_pos.start.line, code_pos.start.column),
        (code_pos.end.line, code_pos.end.column),
        "at EOF the code block's range should be non-empty"
    );

    let blocks = spans(src);
    let report = check_partition(src, &blocks);
    assert!(report.is_partition(), "{:#?}", report.violations);
    assert_eq!(report.content_bytes, report.covered_content_bytes);
}

/// **Negative control (b).** comrak deletes link reference definitions without
/// emitting a node, and `fill_dropped_link_reference_definitions` claims the
/// lines back — but only line-exactly, and only for a line that itself opens
/// the definition. A definition whose destination sits on a continuation line
/// leaves that line matching nothing, so the destination is unclaimed.
///
/// The fill stays narrow on purpose: every line it claims is a line the oracle
/// stops checking, and a continuation rule would have to guess how far a
/// definition runs. Vault exposure is zero (see `print.rs`), so this specimen
/// records the cost of that choice rather than arguing against it.
#[test]
fn a_link_reference_definition_with_a_continued_destination_loses_its_destination() {
    let src = b"[a]:\nhttps://x.io\n\nbody\n";
    let src = std::str::from_utf8(src).unwrap();

    let blocks = spans(src);
    let kinds: Vec<&str> = blocks.iter().map(|b| b.kind).collect();
    assert_eq!(
        kinds,
        vec!["linkReferenceDefinition", "paragraph"],
        "the fill claims the opening line and comrak keeps only `body`"
    );
    assert_eq!(&src[blocks[0].start..blocks[0].end], "[a]:");

    assert_eq!(
        sole_uncovered(src, &blocks),
        "https://x.io",
        "the continuation line holding the destination is what goes missing"
    );

    assert_eq!(
        reassemble(src, &blocks),
        src,
        "reassembly is boundary-insensitive and was expected to be fooled"
    );
}

/// The causal control for the test above: fold the destination onto the
/// opening line and the same definition passes. The differing factor is the
/// line break, not the label or the URL.
#[test]
fn the_same_definition_on_one_line_passes() {
    let src = b"[a]: https://x.io\n\nbody\n";
    let src = std::str::from_utf8(src).unwrap();

    let blocks = spans(src);
    assert_eq!(blocks[0].kind, "linkReferenceDefinition");
    assert_eq!(&src[blocks[0].start..blocks[0].end], "[a]: https://x.io");
    let report = check_partition(src, &blocks);
    assert!(report.is_partition(), "{:#?}", report.violations);
    assert_eq!(report.content_bytes, report.covered_content_bytes);
}
