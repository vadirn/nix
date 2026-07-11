//! Synthetic `highlight_<uid>` fixtures — plan Phase C's pre-producer validation
//! (Q3). `highlight` itself is not built; these exist purely to validate the
//! region engine's inline byte-offset extraction against a second consumer
//! shape before any real producer exists. `tests/regions.rs` (step 5) already
//! covers single-label inline recognition, inline-code/fence inertness,
//! single-pair cross-block pairing, whole-line S7 parity, and the no-flag
//! always-on contract — this file's net-new scope is strictly multi-region
//! geometry: distinct-label interleaving and reused-label LIFO nesting, both
//! built from mid-run (non-whole-line) anchors, plus a highlight-flavored
//! cross-block pair.

use mdstruct::{Options, Span, parse, verify_spans};

fn slice(src: &str, span: Span) -> &str {
    &src[span.start..span.end]
}

/// A region's span nests another's iff it fully contains it. Local copy of the
/// (private) `verify::nests` predicate, used here to assert the negative case
/// (crossing, not nesting) as well as the positive case (LIFO nesting).
fn nests(outer: Span, inner: Span) -> bool {
    outer.start <= inner.start && inner.end <= outer.end
}

/// (a) Two DISTINCT labels whose inline spans interleave: open A, open B,
/// close A, close B. Per-label LIFO pairing is blind to other labels, so A
/// closes on the first `/highlight_a` regardless of B's still-open span —
/// the two regions cross rather than nest.
#[test]
fn distinct_labels_interleave_not_nest() {
    let src = "Lead <!-- highlight_a -->alpha <!-- highlight_b -->beta\
<!-- /highlight_a --> gamma<!-- /highlight_b --> tail\n";
    let d = parse(src, &Options::default());
    verify_spans(&d, src).expect("both regions must satisfy the slice oracle");
    assert_eq!(d.regions.len(), 2);
    assert!(d.dangling.is_empty());

    let open_a = "<!-- highlight_a -->";
    let close_a = "<!-- /highlight_a -->";
    let open_b = "<!-- highlight_b -->";
    let close_b = "<!-- /highlight_b -->";

    let open_a_start = src.find(open_a).unwrap();
    let open_a_end = open_a_start + open_a.len();
    let close_a_start = src.find(close_a).unwrap();
    let close_a_end = close_a_start + close_a.len();
    let open_b_start = src.find(open_b).unwrap();
    let open_b_end = open_b_start + open_b.len();
    let close_b_start = src.find(close_b).unwrap();
    let close_b_end = close_b_start + close_b.len();

    // Regions are sorted by span.start; A opens first so it sorts first even
    // though B closes last.
    let a = &d.regions[0];
    let b = &d.regions[1];
    assert_eq!(a.label, "highlight_a");
    assert_eq!(b.label, "highlight_b");

    assert_eq!(a.span, Span::new(open_a_start, close_a_end));
    assert_eq!(b.span, Span::new(open_b_start, close_b_end));
    assert_eq!(slice(src, a.body_span), "alpha <!-- highlight_b -->beta");
    assert_eq!(slice(src, b.body_span), "beta<!-- /highlight_a --> gamma");

    // Genuine interleaving, not nesting either direction: B starts inside A's
    // span but ends after A's span closes.
    assert!(open_b_start > a.span.start && open_b_start < a.span.end);
    assert!(b.span.end > a.span.end);
    assert!(!nests(a.span, b.span));
    assert!(!nests(b.span, a.span));

    assert_eq!(a.start_line, 1);
    assert_eq!(a.end_line, 1);
    assert_eq!(b.start_line, 1);
    assert_eq!(b.end_line, 1);
}

/// (b) A reused label nests via LIFO: open `highlight_x`, open `highlight_x`,
/// close, close. The first close pops the most recently pushed (inner) open;
/// the second close pairs with the outer open — producing two regions of the
/// SAME label where one fully nests the other.
#[test]
fn reused_label_nests_lifo() {
    let src = "<!-- highlight_x -->outer <!-- highlight_x -->inner\
<!-- /highlight_x --> after<!-- /highlight_x -->\n";
    let d = parse(src, &Options::default());
    verify_spans(&d, src).expect("both regions must satisfy the slice oracle");
    assert_eq!(d.regions.len(), 2);
    assert!(d.dangling.is_empty());

    let open = "<!-- highlight_x -->";
    let close = "<!-- /highlight_x -->";

    let open1_start = src.find(open).unwrap();
    let open1_end = open1_start + open.len();
    let open2_start = open1_end + src[open1_end..].find(open).unwrap();
    let open2_end = open2_start + open.len();
    let close1_start = src.find(close).unwrap();
    let close1_end = close1_start + close.len();
    let close2_start = close1_end + src[close1_end..].find(close).unwrap();
    let close2_end = close2_start + close.len();

    // Sorted by span.start: outer (opens at byte 0) sorts before inner.
    let outer = &d.regions[0];
    let inner = &d.regions[1];
    assert_eq!(outer.label, "highlight_x");
    assert_eq!(inner.label, "highlight_x");

    // LIFO: the first close (close1) paired with the SECOND open (open2, inner).
    assert_eq!(inner.span, Span::new(open2_start, close1_end));
    // The second close (close2) paired with the FIRST open (open1, outer).
    assert_eq!(outer.span, Span::new(open1_start, close2_end));

    assert_eq!(slice(src, inner.body_span), "inner");
    assert_eq!(
        slice(src, outer.body_span),
        "outer <!-- highlight_x -->inner<!-- /highlight_x --> after"
    );

    assert!(nests(outer.span, inner.span), "inner must nest inside outer");

    assert_eq!(outer.start_line, 1);
    assert_eq!(outer.end_line, 1);
    assert_eq!(inner.start_line, 1);
    assert_eq!(inner.end_line, 1);
}

/// (c) + (d) A highlight-labeled open and close sitting in different blocks —
/// open mid-paragraph, close mid-list-item, separated by a blank line — with
/// mid-run (non-whole-line) byte offsets at both ends.
#[test]
fn highlight_pair_crosses_blocks() {
    let src = "Para one <!-- highlight_y -->start of span.\n\n\
- item with <!-- /highlight_y --> close inside a list.\n";
    let d = parse(src, &Options::default());
    verify_spans(&d, src).expect("region must satisfy the slice oracle");
    assert_eq!(d.regions.len(), 1);
    assert!(d.dangling.is_empty());

    let open = "<!-- highlight_y -->";
    let close = "<!-- /highlight_y -->";
    let open_start = src.find(open).unwrap();
    let open_end = open_start + open.len();
    let close_start = src.find(close).unwrap();
    let close_end = close_start + close.len();

    let r = &d.regions[0];
    assert_eq!(r.label, "highlight_y");
    assert_eq!(r.span, Span::new(open_start, close_end));
    assert_eq!(
        slice(src, r.body_span),
        "start of span.\n\n- item with "
    );
    assert_eq!(r.start_line, 1, "open sits in the leading paragraph");
    assert_eq!(r.end_line, 3, "close sits in the list item after a blank line");
    let _ = open_end; // documents the open's own end offset used for body_span
}
