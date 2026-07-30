//! Hermetic fixtures for the block-level passthrough printer and its
//! partition oracle.
//!
//! Every fixture is an embedded byte literal, never an on-disk `.md` file:
//! `mdstruct/tests/roundtrip.rs` set that precedent because a fixture on disk
//! is one `autoformat` pass away from being silently rewritten — and a printer
//! whose fixtures get reformatted tests nothing. Byte literals also let CRLF,
//! a lone `\r`, and a BOM appear exactly as bytes.
//!
//! The fixtures aim at constructs this vault actually holds and that a naive
//! printer would damage. The three tests that matter most are the ones a naive
//! implementation would *pass*:
//! [`reassembly_alone_misses_what_the_partition_catches`] (the vacuous-oracle
//! trap), [`shortening_every_span_by_one_byte_fails_the_partition`] (the
//! injection the oracle must catch), and
//! [`a_dropped_link_reference_definition_fails_the_oracle`] (content comrak
//! deletes must be refused, not tolerated).

use comrak::Arena;
use comrak::nodes::Sourcepos;
use mdformat::{Block, LineIndex, PosReason, Violation, block_spans, check_partition, reassemble};

/// `(name, source)`. Names appear in assertion messages, so keep them short
/// and specific.
const FIXTURES: &[(&str, &str)] = &[
    // --- frontmatter -------------------------------------------------------
    (
        "frontmatter",
        "---\ntitle: A note\ntags: [x]\n---\n\n# H\n\nbody\n",
    ),
    ("frontmatter-only", "---\ntitle: A note\n---\n"),
    ("frontmatter-no-trailing-newline", "---\ntitle: A note\n---"),
    // --- Obsidian callouts -------------------------------------------------
    ("callout", "> [!Note]\n> Callout body.\n\nafter\n"),
    // A blank `>` separator inside the callout: the block quote's span has to
    // cover it, and a printer that dropped or normalized it would change the
    // rendered callout.
    (
        "callout-blank-separator",
        "> [!Warning] Title\n>\n> Body after the separator.\n>\n> Second paragraph.\n\nafter\n",
    ),
    (
        "callout-nested",
        "> [!Note]\n> > inner quote\n> - item\n\nafter\n",
    ),
    (
        "callout-in-list",
        "- item\n  > [!Tip]\n  > tip body\n- next\n\nafter\n",
    ),
    // --- footnote definitions with no reference ----------------------------
    // `extension.footnote` is deliberately OFF (comrak would drop unreferenced
    // definitions), so these parse as paragraphs and the printer emits their
    // bytes. Prose after the colon is what keeps them out of link-reference
    // territory; see `a_dropped_link_reference_definition_fails_the_oracle`.
    (
        "footnote-definitions",
        "Body text.\n\n[^1]: Author, Title, 2020, p. 14.\n[^2]: Second entry, no reference anywhere.\n",
    ),
    (
        "footnote-definition-with-reference",
        "Body text[^1] with a reference.\n\n[^1]: Author, Title, 2020.\n",
    ),
    // A footnote definition whose destination is a single token IS a valid link
    // reference definition, so comrak deletes it and a synthetic block has to
    // claim the line. Four operative vault files rest on this.
    (
        "footnote-definition-bare-url",
        "Body text[^1].\n\n[^1]: https://example.com/a/deep/path\n",
    ),
    (
        "footnote-definitions-mixed",
        "Body.\n\n[^1]: https://example.com\n\n[^2]: Author, Title, 2020.\n\n[^3]: https://x.io\n",
    ),
    (
        "link-reference-definition",
        "[label]: https://example.com\n\nSee [label] and [label].\n",
    ),
    // --- inline tags, math, wikilinks --------------------------------------
    (
        "tags",
        "#tag and #nested/tag mid-sentence.\n\n#leading-tag line\n",
    ),
    ("math-inline", "Inline $x^2 + y^2 = z^2$ math.\n"),
    (
        "math-block",
        "Before.\n\n$$\n\\sum_{i=0}^{n} i\n$$\n\nAfter.\n",
    ),
    (
        "wikilinks",
        "A [[Plain Note]], an [[Note|alias]], an escaped [[Note\\|alias]], an ![[Embed]].\n",
    ),
    (
        "wikilink-in-table",
        "| a | b |\n|---|---|\n| [[Note\\|alias]] | x \\| y |\n",
    ),
    // --- tables, lists, code -----------------------------------------------
    (
        "table",
        "| left | right |\n| --- | ---: |\n| 1 | 2 |\n| 3 | 4 |\n\nafter\n",
    ),
    (
        "table-ragged",
        "| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |\n",
    ),
    ("nested-list", "- a\n  - b\n    - c\n- d\n\nafter\n"),
    ("loose-list", "- a\n\n- b\n\n- c\n\nafter\n"),
    (
        "list-with-paragraph",
        "- a\n\n  continued\n\n- b\n\nafter\n",
    ),
    ("ordered-list", "1. a\n2. b\n10. c\n\nafter\n"),
    ("task-list", "- [ ] todo\n- [x] done\n\nafter\n"),
    // A list at EOF: its span ends on the last content line, and the trailing
    // newline lands in the gap the printer copies verbatim.
    ("list-at-eof", "- a\n- b\n"),
    ("list-then-blank-lines", "- a\n\n\n\nafter\n"),
    (
        "fenced-code-markdown-info",
        "```markdown\n# Not a heading to reformat\n\n*   badly   spaced   list\n```\n\nafter\n",
    ),
    (
        "fenced-code-nested-fence",
        "````markdown\n```\ninner\n```\n````\n\nafter\n",
    ),
    (
        "fenced-code-indented",
        "  ```rust\n  let x = 1;\n  ```\n\nafter\n",
    ),
    ("fenced-code-unclosed", "```\nnever closed\n"),
    ("indented-code", "para\n\n    indented code\n\nafter\n"),
    // An indented code block inside a list item, which truncates the sourcepos
    // of every container above it — reduced from `30 notes/Goals.md`.
    (
        "indented-code-in-list",
        "1.  First [P1]\n\n        - Status: In Development\n\n2.  Second [P2]\n\n        - Status: Assisting\n\n---\n",
    ),
    ("tab-indented-code", "para\n\n\tcode\n\nafter\n"),
    // --- whitespace, encodings, endings ------------------------------------
    ("double-blank-lines", "a\n\n\nb\n"),
    ("triple-blank-lines", "a\n\n\n\nb\n"),
    ("trailing-blank-lines", "a\n\n\n\n"),
    ("leading-blank-lines", "\n\n# H\n"),
    ("bom", "\u{feff}# H\n\nbody\n"),
    ("bom-frontmatter", "\u{feff}---\ntitle: x\n---\n\nbody\n"),
    ("crlf", "# H\r\n\r\npara one\r\n\r\n- a\r\n- b\r\n"),
    ("crlf-frontmatter", "---\r\ntitle: x\r\n---\r\n\r\n# H\r\n"),
    ("lone-cr", "a\r## H\rbody\r"),
    ("no-trailing-newline", "# H\n\npara"),
    ("empty", ""),
    ("blank-only", "\n\n\n"),
    ("whitespace-only", "  \t \n \n"),
    // --- other block shapes ------------------------------------------------
    ("setext-heading", "Title\n=====\n\nSub\n---\n\nbody\n"),
    ("thematic-break", "a\n\n***\n\nb\n\n---\n\nc\n"),
    (
        "html-block",
        "<div class=\"x\">\n  <p>y</p>\n</div>\n\nafter\n",
    ),
    (
        "html-comment",
        "<!-- a comment\n     spanning lines -->\n\nafter\n",
    ),
    ("block-quote", "> quoted\n> lines\n\nafter\n"),
    ("hard-breaks", "a  \nb\n\nc\\\nd\n"),
    ("cyrillic", "## Заметка о структуре\n\nтекст с *акцентом*\n"),
    ("emoji", "Ship it 🚀 today\n\n- 🎉 party\n"),
    ("nbsp-paragraph", "a\n\n\u{a0}\n\nb\n"),
    (
        "kitchen-sink",
        "\u{feff}---\ntitle: Kitchen sink\n---\n\n# H\n\n> [!Note]\n>\n> A callout with $x$ and #tag.\n\n| a | b |\n|---|---|\n| [[N\\|a]] | 2 |\n\n- item\n  - nested\n\n```markdown\n#   not reformatted\n```\n\n$$\nx = 1\n$$\n\n[^1]: Author, Title, 2020.\n\n\n\nlast\n",
    ),
];

fn spans(source: &str) -> Vec<Block> {
    let arena = Arena::new();
    let opts = mdstruct::Options::default();
    mdformat::parse_with(&arena, source, &opts, |root| {
        block_spans(root, source).unwrap_or_else(|e| panic!("sourcepos errors: {e:?}"))
    })
}

/// Shorten every span's end by one byte — the injection an oracle has to
/// catch, and the one a "span slices plus gap bytes" comparison does not.
fn shorten_every_span(blocks: &[Block]) -> Vec<Block> {
    blocks
        .iter()
        .map(|b| Block {
            end: b.end.saturating_sub(1).max(b.start),
            ..b.clone()
        })
        .collect()
}

#[test]
fn every_fixture_partitions_its_content_bytes() {
    let opts = mdstruct::Options::default();
    for (name, src) in FIXTURES {
        let r = mdformat::fixpoint(src, &opts).unwrap_or_else(|e| panic!("{name}: {e:?}"));
        assert!(
            r.partition.is_partition(),
            "{name}: {:#?}",
            r.partition.violations
        );
        assert_eq!(
            r.partition.content_bytes, r.partition.covered_content_bytes,
            "{name}: content bytes unaccounted for"
        );
        assert!(r.matches_input, "{name}: printer changed the bytes");
        assert!(r.passed(), "{name}");
    }
}

/// Every span must slice the bytes it claims without panicking and without
/// crossing a character boundary — the fixtures include Cyrillic, emoji, and a
/// non-breaking space precisely to exercise the byte-column arithmetic.
#[test]
fn every_span_slices_cleanly() {
    for (name, src) in FIXTURES {
        for b in spans(src) {
            assert!(
                src.is_char_boundary(b.start) && src.is_char_boundary(b.end),
                "{name}: {} span {}..{} splits a character",
                b.kind,
                b.start,
                b.end
            );
            let _ = &src[b.start..b.end];
        }
    }
}

/// The injection. Shortening every span's end by one byte must make the
/// partition check fail, on every fixture that has a block ending in content.
#[test]
fn shortening_every_span_by_one_byte_fails_the_partition() {
    for (name, src) in FIXTURES {
        let blocks = spans(src);
        // A fixture with no blocks (an empty or whitespace-only file) has
        // nothing to corrupt, and one whose every span ends on whitespace
        // leaks only whitespace, which is legitimately unclaimed.
        let corruptible = blocks
            .iter()
            .any(|b| b.end > b.start && !src.as_bytes()[b.end - 1].is_ascii_whitespace());
        let report = check_partition(src, &shorten_every_span(&blocks));
        if corruptible {
            assert!(
                !report.is_partition(),
                "{name}: the oracle failed to catch a one-byte span shortening"
            );
            assert!(
                report
                    .violations
                    .iter()
                    .any(|v| matches!(v, Violation::Uncovered { .. })),
                "{name}: expected uncovered content, got {:?}",
                report.violations
            );
            assert!(
                report.covered_content_bytes < report.content_bytes,
                "{name}: byte accounting should show the shortfall"
            );
        } else {
            assert!(
                report.is_partition(),
                "{name}: only whitespace was leaked, which is not a violation: {:?}",
                report.violations
            );
        }
    }
}

/// The trap this milestone exists to avoid, as a live assertion: the printer's
/// own output is boundary-insensitive, so equality with the input is satisfied
/// by a span set the partition oracle rejects. Anyone tempted to drop the
/// oracle and keep `print(parse(f)) == f` has to delete this test first.
#[test]
fn reassembly_alone_misses_what_the_partition_catches() {
    let mut checked = 0usize;
    for (name, src) in FIXTURES {
        let blocks = spans(src);
        let corrupted = shorten_every_span(&blocks);
        let report = check_partition(src, &corrupted);
        if report.is_partition() {
            continue; // nothing was actually corrupted; see the test above
        }
        assert_eq!(
            reassemble(src, &corrupted),
            *src,
            "{name}: reassembly was expected to be fooled by the injection"
        );
        checked += 1;
    }
    assert!(
        checked > 20,
        "the trap should be demonstrated across the corpus, not on one fixture"
    );
}

/// comrak agrees with `LineIndex` that a lone `\r` ends a line. Verified
/// against a real parse rather than assumed from CommonMark: with `\n`-only
/// line counting, line 2 would start at byte 7 instead of byte 2 and the
/// heading span would slice the wrong bytes — or, under this crate's strict
/// conversion, fail as an out-of-range line.
#[test]
fn lone_cr_is_a_line_ending_for_comrak_too() {
    let src = "a\r## H\rbody\r";
    let blocks = spans(src);
    let kinds: Vec<&str> = blocks.iter().map(|b| b.kind).collect();
    assert_eq!(kinds, vec!["paragraph", "heading", "paragraph"]);
    assert_eq!(&src[blocks[0].start..blocks[0].end], "a");
    assert_eq!(&src[blocks[1].start..blocks[1].end], "## H");
    assert_eq!(blocks[1].start, 2, "line 2 begins right after the lone \\r");
    assert_eq!(&src[blocks[2].start..blocks[2].end], "body");
    assert!(check_partition(src, &blocks).is_partition());
}

/// A CRLF file's spans must stop before the `\r`, leaving both bytes to the
/// gap the printer copies verbatim.
#[test]
fn crlf_line_endings_stay_outside_the_spans() {
    let src = "# H\r\n\r\npara\r\n";
    let blocks = spans(src);
    assert_eq!(&src[blocks[0].start..blocks[0].end], "# H");
    assert_eq!(&src[blocks[1].start..blocks[1].end], "para");
    assert!(check_partition(src, &blocks).is_partition());
}

/// A link reference definition is consumed by comrak with no node emitted, so
/// its bytes belong to no comrak span. They must still be claimed, by a
/// synthetic `linkReferenceDefinition` block, or the printer would delete
/// content — and the oracle would report it, since it has no tolerance for
/// unclaimed bytes.
#[test]
fn a_dropped_link_reference_definition_is_claimed_by_a_synthetic_block() {
    let src = "[label]: https://example.com\n\nSee [label].\n";
    let blocks = spans(src);
    let kinds: Vec<&str> = blocks.iter().map(|b| b.kind).collect();
    assert_eq!(kinds, vec!["linkReferenceDefinition", "paragraph"]);
    assert_eq!(blocks[0].sourcepos, None, "no comrak node backs it");
    assert_eq!(
        &src[blocks[0].start..blocks[0].end],
        "[label]: https://example.com"
    );
    assert!(check_partition(src, &blocks).is_partition());
    assert_eq!(reassemble(src, &blocks), src);
}

/// The same hazard reached through a footnote definition, which is how this
/// vault keeps bibliographies. With a single-token destination,
/// `[^1]: https://x.io` IS a valid link reference definition and comrak
/// deletes it; `[^1]: Author, Title, 2020` is not one and survives as a
/// paragraph. Four operative vault files hold the deleted form, so this pins
/// both sides of the boundary.
#[test]
fn a_footnote_definition_is_claimed_whether_or_not_comrak_keeps_it() {
    let prose = "[^1]: Author, Title, 2020.\n";
    let prose_blocks = spans(prose);
    assert_eq!(prose_blocks[0].kind, "paragraph");
    assert!(check_partition(prose, &prose_blocks).is_partition());

    let bare = "Body[^1]\n\n[^1]: https://x.io\n";
    let bare_blocks = spans(bare);
    let kinds: Vec<&str> = bare_blocks.iter().map(|b| b.kind).collect();
    assert_eq!(kinds, vec!["paragraph", "linkReferenceDefinition"]);
    assert!(check_partition(bare, &bare_blocks).is_partition());
    assert_eq!(reassemble(bare, &bare_blocks), bare);
}

/// The claim is line-exact: a line that shares itself with any block span is
/// never claimed, however linkref-shaped it looks. That is what keeps the fill
/// from blunting the injection test — a leaked byte always shares its line with
/// the span that leaked it.
#[test]
fn the_fill_never_claims_a_line_a_block_already_touches() {
    // `[x]: y` here is inside a fenced code block, so the fence owns the line.
    let src = "```\n[x]: y\n```\n";
    let blocks = spans(src);
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0].kind, "codeBlock");
    assert!(check_partition(src, &blocks).is_partition());
}

/// An out-of-range sourcepos is an error naming the node kind and the
/// position, not the silent clamp `mdstruct::core::span` applies. A printer
/// that clamped would emit a shortened block with no signal at all.
#[test]
fn an_out_of_range_sourcepos_errors_instead_of_clamping() {
    let idx = LineIndex::new("# H\n");

    let past_end = idx
        .byte_span("heading", Sourcepos::from((1, 1, 1, 99)))
        .unwrap_err();
    assert_eq!(past_end.kind, "heading");
    assert_eq!(past_end.reason, PosReason::PastEnd { offset: 99, len: 4 });
    assert!(past_end.to_string().contains("heading at 1:1-1:99"));

    let bad_line = idx
        .byte_span("paragraph", Sourcepos::from((7, 1, 7, 4)))
        .unwrap_err();
    assert_eq!(
        bad_line.reason,
        PosReason::LineOutOfRange { line: 7, lines: 2 }
    );
}

/// Consecutive blank lines are preserved verbatim, byte for byte. The vault has
/// 427 double-blank and 71 triple-blank gaps; normalizing them is out of scope
/// for this milestone, so the printer must not touch them.
#[test]
fn consecutive_blank_lines_survive_verbatim() {
    for src in [
        "a\n\nb\n",
        "a\n\n\nb\n",
        "a\n\n\n\nb\n",
        "a\n\n\n\n\n\n\nb\n",
        "a\r\n\r\n\r\nb\r\n",
    ] {
        let blocks = spans(src);
        assert!(check_partition(src, &blocks).is_partition(), "{src:?}");
        assert_eq!(reassemble(src, &blocks), src, "{src:?}");
    }
}

/// A fence whose info string is `markdown` must come back exactly as written,
/// including the badly spaced list inside it. This is the fixture that would
/// fail immediately if the printer ever routed through comrak's own renderer.
#[test]
fn a_markdown_fence_is_not_reformatted() {
    let src = "```markdown\n*   spaced   list\n#   heading\n```\n";
    let blocks = spans(src);
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0].kind, "codeBlock");
    assert_eq!(
        &src[blocks[0].start..blocks[0].end],
        "```markdown\n*   spaced   list\n#   heading\n```"
    );
    assert_eq!(reassemble(src, &blocks), src);
}

/// Block children are not claimed alongside their parent: a list's span covers
/// its items, and pushing the items too would be an overlap the oracle
/// reports. This pins the block-level scope decision.
#[test]
fn only_top_level_blocks_are_claimed() {
    let src = "- a\n  - b\n- c\n\n> quoted\n";
    let blocks = spans(src);
    let kinds: Vec<&str> = blocks.iter().map(|b| b.kind).collect();
    assert_eq!(kinds, vec!["list", "blockQuote"]);
    // The union with the items' ranges pulls in the list's trailing newline —
    // a list item's reported end is the start of the line after it. Harmless
    // to a passthrough printer, and a known hazard for a later one that
    // rewrites a list and re-joins the blocks.
    assert_eq!(&src[blocks[0].start..blocks[0].end], "- a\n  - b\n- c\n");
    assert_eq!(&src[blocks[1].start..blocks[1].end], "> quoted");
}

/// comrak truncates a container's end when an indented code block sits inside a
/// list item, which is why every top-level span is the union of its own range
/// and its block descendants'. Reduced from `30 notes/Goals.md`, where the
/// raw sourcepos left 179 bytes of list content in no span at all: the item's
/// own code block reports an EMPTY range, and only the last item's spans are
/// right. Both halves are asserted, so a comrak release that fixes the
/// truncation shows up here as a failure to explain rather than as silence.
#[test]
fn a_truncated_container_span_is_repaired_by_its_descendants() {
    let src = "1.  First [P1]\n\n        - Status: In Development\n        - Purpose: x\n\n\
               2.  Second [P2]\n\n        - Status: Assisting\n        - Priority: Lower\n\n---\n";
    let arena = Arena::new();
    let opts = mdstruct::Options::default();
    let (own, expanded) = mdformat::parse_with(&arena, src, &opts, |root| {
        let idx = LineIndex::new(src);
        let list = root.first_child().expect("a list");
        let own = idx
            .byte_span("list", list.data.borrow().sourcepos)
            .expect("converts");
        let expanded = block_spans(root, src).expect("converts");
        (own, expanded)
    });

    let last_content = src.find("- Priority: Lower").unwrap() + "- Priority: Lower".len();
    assert!(
        own.1 < last_content,
        "comrak's own list span was expected to truncate, ending at {} of {last_content}",
        own.1
    );
    assert_eq!(expanded[0].kind, "list");
    assert!(
        expanded[0].end >= last_content,
        "the union must reach the last content byte"
    );
    assert!(check_partition(src, &expanded).is_partition());
    assert_eq!(reassemble(src, &expanded), src);
}
