//! Integration test: mdformat's parse must run under the SAME comrak
//! configuration mdstruct uses — not a re-derived approximation — exercised
//! end to end through a real `comrak::parse_document` call, not just a
//! struct-equality check on options. Fixtures are embedded byte literals
//! (mdstruct/tests/roundtrip.rs sets this precedent) so no on-disk .md file
//! risks getting reformatted by an editor or autoformat pass.

use comrak::Arena;
use comrak::nodes::NodeValue;

/// mdstruct deliberately leaves `extension.footnote` OFF: comrak would
/// otherwise silently DROP unreferenced footnote definitions, breaking
/// mdstruct's total tiling and erasing the vault's
/// footnote-definitions-as-bibliography citations (see the long comment on
/// `mdstruct::core::build::comrak_options`). mdformat inherits that setting
/// purely by calling `mdstruct::comrak_options` — this test proves the
/// inheritance actually holds under a real parse, not just in the options
/// struct: a footnote-style block must parse as a paragraph (so the printer,
/// once built, has real bytes to reconstruct from), never vanish as a
/// dropped `FootnoteDefinition`.
#[test]
fn shared_options_keep_footnote_definitions_as_paragraphs() {
    let src = "[^1]: A footnote-style bibliography entry, vault convention.\n\nBody text.\n";
    let opts = mdstruct::Options::default();
    let comrak_opts = mdformat::comrak_options(&opts);
    let arena = Arena::new();
    let root = comrak::parse_document(&arena, src, &comrak_opts);

    let has_footnote_def = root
        .descendants()
        .any(|n| matches!(n.data.borrow().value, NodeValue::FootnoteDefinition(_)));
    assert!(
        !has_footnote_def,
        "shared options must leave footnotes off, matching mdstruct exactly"
    );

    let paragraph_count = root
        .descendants()
        .filter(|n| matches!(n.data.borrow().value, NodeValue::Paragraph))
        .count();
    assert_eq!(
        paragraph_count, 2,
        "the footnote-style line and the body line both survive as paragraphs"
    );
}

/// The same shared options must also turn on the extensions mdstruct's own
/// comment documents (table, strikethrough, tasklist, autolink, front
/// matter) — spot-check a couple that are otherwise off by comrak default,
/// again through a real parse rather than a field read.
#[test]
fn shared_options_enable_documented_extensions() {
    let src = "---\ntitle: x\n---\n\n~~strike~~ and https://example.com bare\n\n- [x] done\n";
    let opts = mdstruct::Options::default();
    let comrak_opts = mdformat::comrak_options(&opts);
    let arena = Arena::new();
    let root = comrak::parse_document(&arena, src, &comrak_opts);

    let mut has_frontmatter = false;
    let mut has_strikethrough = false;
    let mut has_autolink = false;
    let mut has_tasklist = false;
    for n in root.descendants() {
        match n.data.borrow().value {
            NodeValue::FrontMatter(_) => has_frontmatter = true,
            NodeValue::Strikethrough => has_strikethrough = true,
            NodeValue::Link(_) => has_autolink = true,
            NodeValue::TaskItem(_) => has_tasklist = true,
            _ => {}
        }
    }
    assert!(has_frontmatter, "front_matter_delimiter must be set");
    assert!(has_strikethrough, "extension.strikethrough must be on");
    assert!(has_autolink, "extension.autolink must be on");
    assert!(has_tasklist, "extension.tasklist must be on");
}

/// A realistic document under the shared options — front matter, a wikilink, an
/// inline link, a list — parses into spans that partition its content bytes.
/// That partition is the whole verdict: reassembly equality used to be asserted
/// alongside it here, and was dropped because it is satisfied by corrupt span
/// sets too. `tests/partition.rs` holds the injection that proves it.
#[test]
fn spans_partition_a_realistic_document() {
    let src = "---\ntitle: x\n---\n# Heading\n\nSome *text* with a [[Wikilink]] and a [link](https://x.io).\n\n- one\n- two\n";
    let opts = mdstruct::Options::default();
    let part = mdformat::partition(src, &opts).expect("every sourcepos converts");
    assert!(part.passed(), "{:?}", part.report.violations);
    assert_eq!(part.report.content_bytes, part.report.covered_content_bytes);
}
