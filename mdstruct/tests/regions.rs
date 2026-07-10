//! End-to-end coverage for the always-on masked region scanner (plan Phase A).
//! The `region.rs` unit tests drive `scan()` with a hand-built mask; these drive
//! the whole `parse()` path so build.rs's mask construction (fenced-code spans +
//! inline `NodeValue::Code` spans) is exercised for real — the layer the unit
//! tests bypass. Scope: inline recognition, inline-code/fenced masking,
//! cross-block pairing, whole-line parity under a real fence mask, and the
//! no-flag always-on contract.

use mdstruct::{Options, Span, parse, verify_spans};

fn slice(src: &str, span: Span) -> &str {
    &src[span.start..span.end]
}

/// (7) Always-on with no flag: a plain `parse` under `Options::default()` emits
/// the anchor pair into `regions[]`, and it reaches the serialized wire form
/// (no `--region` registration exists any more).
#[test]
fn always_on_populates_regions_with_default_options() {
    let src = "<!-- keep -->\nbody\n<!-- /keep -->\n";
    let d = parse(src, &Options::default());
    assert_eq!(d.regions.len(), 1, "extraction is unconditional");
    assert_eq!(d.regions[0].label, "keep");
    assert_eq!(slice(src, d.regions[0].body_span), "body\n");

    // And it is on the wire — regions[] serializes with no opt-in flag.
    let json: serde_json::Value =
        serde_json::from_str(&serde_json::to_string(&d).unwrap()).unwrap();
    let regions = json["regions"].as_array().expect("regions[] present");
    assert_eq!(regions.len(), 1);
    assert_eq!(regions[0]["label"], "keep");
}

/// (2) Inline recognition: a mid-run `<!-- open -->…<!-- close -->` inside a
/// text paragraph pairs with byte-offset spans (not line boundaries), and the
/// region-slice oracle accepts the inline span.
#[test]
fn inline_anchor_pair_recognized_in_paragraph() {
    let src = "Lead text <!-- hl -->marked<!-- /hl --> and a tail.\n";
    let d = parse(src, &Options::default());
    verify_spans(&d, src).expect("inline region must satisfy the slice oracle");
    assert_eq!(d.regions.len(), 1);
    assert!(d.dangling.is_empty());
    let r = &d.regions[0];
    assert_eq!(r.label, "hl");

    let open_start = src.find("<!-- hl -->").unwrap();
    let close_end = src.find("<!-- /hl -->").unwrap() + "<!-- /hl -->".len();
    // Byte-offset endpoints, not the enclosing line.
    assert_eq!(r.span.start, open_start);
    assert_eq!(r.span.end, close_end);
    assert_eq!(slice(src, r.body_span), "marked");
    assert_eq!(r.start_line, 1);
    assert_eq!(r.end_line, 1);
}

/// (3a) Inline-code skip: an anchor inside inline code `` `<!-- x -->` `` is
/// inert. Both endpoints buried in inline code → nothing pairs and nothing
/// dangles. This exercises build.rs's `NodeValue::Code` mask pass.
#[test]
fn inline_code_anchors_are_inert() {
    let src = "prose `<!-- x -->` and `<!-- /x -->` done.\n";
    let d = parse(src, &Options::default());
    assert!(d.regions.is_empty(), "inline-code anchors must not pair");
    assert!(d.dangling.is_empty(), "masked anchors do not dangle either");
}

/// (3b) Fenced-block skip: a balanced open/close inside a fenced code block is
/// inert. Exercises build.rs's `fenced_code_spans` mask.
#[test]
fn fenced_block_anchors_are_inert() {
    let src = "before\n\n```\n<!-- x -->\n<!-- /x -->\n```\n\nafter\n";
    let d = parse(src, &Options::default());
    assert!(d.regions.is_empty(), "in-fence anchors must not pair");
    assert!(d.dangling.is_empty(), "in-fence anchors do not dangle");
}

/// (4) Cross-block pairing: an open mid-paragraph in one block and a close
/// embedded in a later heading pair across the intervening blocks, with
/// byte-offset endpoints and the correct open/close line numbers.
#[test]
fn cross_block_open_and_close_pair() {
    let src = "Intro <!-- note --> continues here.\n\n## Section <!-- /note -->\n\ntail\n";
    let d = parse(src, &Options::default());
    verify_spans(&d, src).expect("cross-block region must satisfy the slice oracle");
    assert_eq!(d.regions.len(), 1);
    assert!(d.dangling.is_empty());
    let r = &d.regions[0];
    assert_eq!(r.label, "note");

    let open_start = src.find("<!-- note -->").unwrap();
    let close_end = src.find("<!-- /note -->").unwrap() + "<!-- /note -->".len();
    assert_eq!(r.span.start, open_start);
    assert_eq!(r.span.end, close_end);
    assert_eq!(r.start_line, 1, "open sits on line 1");
    assert_eq!(r.end_line, 3, "close sits on the heading line 3");
    // Body spans the run from the open's end to the close's start, across blocks.
    assert_eq!(slice(src, r.body_span), " continues here.\n\n## Section ");
}

/// (1) Whole-line parity under a real fence mask: the S7 shape — a whole-line
/// open outside any fence, a stray same-label close buried in a fenced block,
/// and the real whole-line close later — pairs the open with the REAL close and
/// keeps the byte-identical line-based span, now through the always-on parse
/// path (build.rs builds the fence mask, not the test).
#[test]
fn whole_line_parity_survives_masked_fence() {
    let src = "\
alpha
<!-- interact: foo -->
epsilon
```
<!-- /interact -->
```
zeta
<!-- /interact -->
";
    let d = parse(src, &Options::default());
    verify_spans(&d, src).expect("whole-line region must satisfy the slice oracle");
    assert_eq!(d.regions.len(), 1);
    assert!(d.dangling.is_empty(), "the in-fence close is masked, not dangling");
    let r = &d.regions[0];
    assert_eq!(r.label, "interact");
    assert_eq!(r.info.as_deref(), Some("foo"));
    assert_eq!(r.start_line, 2, "open line");
    assert_eq!(r.end_line, 8, "real close line, not the in-fence one on line 5");
    // Whole-line convention: span runs from the open line start to just past the
    // close line — byte-identical to the pre-rewrite scanner.
    assert_eq!(slice(src, r.span), "<!-- interact: foo -->\nepsilon\n```\n<!-- /interact -->\n```\nzeta\n<!-- /interact -->\n");
}
