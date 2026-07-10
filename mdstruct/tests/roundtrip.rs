//! The intrinsic freeze gate over the mandatory fixtures (Decision 17 clause E),
//! plus golden interior-span assertions that tiling and inline fidelity cannot
//! see. Fixtures are embedded byte literals (not on-disk .md) so a markdown
//! formatter cannot mangle CRLF/BOM/closing-hash bytes.

use mdstruct::{Node, Options, parse, verify_spans};

fn doc(src: &str) -> mdstruct::Document {
    let d = parse(src, &Options::default());
    verify_spans(&d, src).expect("freeze gate must pass on fixture");
    d
}

fn slice(src: &str, span: mdstruct::Span) -> &str {
    &src[span.start..span.end]
}

/// The §2 worked example (LF, ASCII). Golden interior-span semantics.
#[test]
fn example_interior_spans() {
    let src = "---\ntitle: Example\n---\n# Guide\n\nText [link](https://x.io) and [[Note#Sec|alias]].\n\n## Setup\n\n```rust\nlet x = 1;\n```\n";
    let d = doc(src);

    // Frontmatter: present, body starts after the block.
    let fm = d.frontmatter().expect("frontmatter present");
    assert_eq!(fm.format.as_deref(), Some("yaml"));
    assert_eq!(fm.body_start_line, 4);

    // H1 → H2 nested; textSpan excludes the `#` markers.
    assert_eq!(d.headings.len(), 1);
    let h1 = &d.headings[0];
    assert_eq!(h1.level, 1);
    assert_eq!(slice(src, h1.text_span), "Guide");
    assert_eq!(h1.children.len(), 1);
    let h2 = &h1.children[0];
    assert_eq!(slice(src, h2.text_span), "Setup");
    // Section extends to EOF for both. The source is 12 lines (the trailing
    // newline adds no phantom line), so both sectionEndLine land on 12.
    assert_eq!(h1.section_span.end, src.len());
    assert_eq!(h2.section_span.end, src.len());
    assert_eq!(h1.section_end_line, 12);
    assert_eq!(h2.section_end_line, 12);

    // codeBlock: bodySpan is the RAW body (no fence, no trailing newline);
    // infoSpan is the info string.
    let cb = d
        .nodes
        .iter()
        .find(|n| matches!(n, Node::CodeBlock { .. }))
        .unwrap();
    if let Node::CodeBlock { info_span, body_span, info, .. } = cb {
        assert_eq!(info, "rust");
        assert_eq!(slice(src, info_span.unwrap()), "rust");
        assert_eq!(slice(src, *body_span), "let x = 1;");
    }

    // Inlines: link + wikilink decomposed.
    let wl = d
        .inlines
        .iter()
        .find(|i| matches!(i, mdstruct::Inline::Wikilink { .. }))
        .unwrap();
    if let mdstruct::Inline::Wikilink { target, page, heading, block, embed, alias, alias_span, .. } = wl {
        assert_eq!(target, "Note#Sec");
        assert_eq!(page, "Note");
        assert_eq!(heading.as_deref(), Some("Sec"));
        assert_eq!(*block, None);
        assert!(!*embed);
        assert_eq!(alias.as_deref(), Some("alias"));
        assert_eq!(slice(src, alias_span.unwrap()), "alias");
    }
}

/// 1.1 table-cell backlinks: a plain wikilink and an embed inside GFM cells are
/// emitted (the `in_table` guard and whole-table mask no longer suppress them),
/// the freeze gate passes (the oracle exempts cell wikilinks), and the consumer
/// reads decoded `target`/`alias` rather than the imprecise span.
#[test]
fn table_cell_wikilink_and_embed() {
    let src = "| Ref | Note |\n| --- | --- |\n| [[Alpha]] | ![[Beta]] |\n| [[Gamma\\|display]] | x |\n";
    let d = doc(src);
    let wl = |target: &str| {
        d.inlines.iter().find_map(|i| match i {
            mdstruct::Inline::Wikilink { target: t, alias, embed, .. } if t == target => {
                Some((alias.clone(), *embed))
            }
            _ => None,
        })
    };
    // Plain cell wikilink: target from decoded url, no pipe → alias None.
    assert_eq!(wl("Alpha"), Some((None, false)));
    // Cell embed: emitted with embed:true, byte-exact span.
    assert_eq!(wl("Beta"), Some((None, true)));
    // Escaped-pipe cell wikilink: alias recovered from the decoded display.
    assert_eq!(wl("Gamma"), Some((Some("display".to_string()), false)));
}

/// 1.1 empty-pipe `[[X|]]`: pipe present, empty display. `alias` is `Some("")`,
/// distinct from a no-pipe `[[X]]` whose `alias` is `None` — the distinction a
/// raw `alias_span` (present as `Some(page)` for no-pipe links) cannot carry.
#[test]
fn empty_pipe_wikilink() {
    let src = "See [[Topic|]] and [[Topic]].\n";
    let d = doc(src);
    let aliases: Vec<Option<String>> = d
        .inlines
        .iter()
        .filter_map(|i| match i {
            mdstruct::Inline::Wikilink { alias, .. } => Some(alias.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(aliases, vec![Some(String::new()), None]);
}

/// Cyrillic-terminal block: the exclusive-end arithmetic must not overshoot.
#[test]
fn cyrillic_terminal() {
    let src = "## Заметка\n\nтекст [[Ссылка]] конец\n";
    let d = doc(src);
    let h = &d.headings[0];
    assert_eq!(slice(src, h.span), "## Заметка");
    assert_eq!(slice(src, h.text_span), "Заметка");
    let wl = &d.inlines[0];
    assert!(slice(src, wl.span()).starts_with("[[") && slice(src, wl.span()).ends_with("]]"));
}

/// CRLF: the freeze gate holds; `\r` lives in the inter-block gap.
#[test]
fn crlf() {
    let src = "# Title\r\n\r\nA paragraph with [[Note]].\r\n";
    let d = doc(src);
    assert_eq!(d.headings.len(), 1);
    assert_eq!(slice(src, d.headings[0].text_span), "Title");
    // The wikilink slices exactly despite CRLF line endings.
    let wl = &d.inlines[0];
    assert_eq!(slice(src, wl.span()), "[[Note]]");
}

/// Leading BOM: the gate holds (BOM is treated as ignorable in the leading gap).
#[test]
fn bom() {
    let src = "\u{feff}# Heading\n\nbody\n";
    let d = doc(src);
    assert_eq!(slice(src, d.headings[0].text_span), "Heading");
    // The BOM stays unowned-in-gap: it is never emitted as an Unknown node.
    assert!(
        !d.nodes.iter().any(|n| matches!(n, Node::Unknown { .. })),
        "BOM must not surface as an Unknown uncovered node"
    );
    // And the freeze gate (now including the no-Unknown check) still passes.
    verify_spans(&d, src).expect("freeze gate must pass with a leading BOM");
}

/// Unclosed frontmatter: no frontmatter recognized, body starts at line 1.
#[test]
fn unclosed_frontmatter() {
    let src = "---\ntitle: x\n# Not closed\n\nbody\n";
    let d = doc(src);
    assert!(d.frontmatter().is_none());
    assert_eq!(d.frontmatter.body_start_line, 1);
    assert_eq!(d.frontmatter.body_start_byte, 0);
}

/// ATX closing-hash: comrak strips the trailing `##`; textSpan excludes it.
#[test]
fn closing_hash() {
    let src = "## Foo ##\n\nbody\n";
    let d = doc(src);
    let h = &d.headings[0];
    assert_eq!(slice(src, h.span), "## Foo ##");
    assert_eq!(slice(src, h.text_span), "Foo");
}

/// Setext heading: level 1, setext flag set, text on the line above the rule.
#[test]
fn setext() {
    let src = "Title\n=====\n\nbody\n";
    let d = doc(src);
    let h = &d.headings[0];
    assert_eq!(h.level, 1);
    assert!(h.setext);
    assert_eq!(slice(src, h.text_span), "Title");
}

/// Nested/overlapping regions: the region-slice check holds, both emitted.
#[test]
fn nested_regions() {
    let src = "<!-- outer -->\n<!-- inner -->\ncontent\n<!-- /inner -->\n<!-- /outer -->\n";
    let opts = Options { wikilinks: true };
    let d = parse(src, &opts);
    verify_spans(&d, src).expect("region-slice check must pass");
    assert_eq!(d.regions.len(), 2);
    // Overlapping by design: inner's span sits within outer's.
    let outer = d.regions.iter().find(|r| r.label == "outer").unwrap();
    let inner = d.regions.iter().find(|r| r.label == "inner").unwrap();
    assert!(outer.span.start <= inner.span.start && inner.span.end <= outer.span.end);
    assert_eq!(slice(src, inner.body_span), "content\n");
}

/// Link reference definition (`[^n]: url`) is recovered as a located node.
#[test]
fn link_reference_definition_recovered() {
    let src = "See the note.\n\n[^1]: https://example.com/x\n";
    let d = doc(src);
    let lrd = d
        .nodes
        .iter()
        .find(|n| matches!(n, Node::LinkReferenceDefinition { .. }))
        .expect("link reference definition recovered as a node");
    assert_eq!(slice(src, lrd.span()), "[^1]: https://example.com/x");
}

/// A file whose only bytes are a leading BOM (optionally + whitespace) tiles as
/// an all-ignorable document — the BOM leads the otherwise-empty trailing region
/// — so the gate passes, consistent with a whitespace-only file and with no
/// `uncovered` node emitted.
#[test]
fn bom_only_file_passes_gate() {
    for src in ["\u{feff}", "\u{feff}\n\n  \n", "\u{feff}   \n"] {
        let d = parse(src, &Options::default());
        assert!(verify_spans(&d, src).is_ok(), "BOM-only src {src:?} must pass the gate");
        assert!(
            !d.nodes.iter().any(|n| matches!(n, Node::Unknown { .. })),
            "BOM-only src {src:?} must not emit an unknown node"
        );
    }
}

/// Backslash parity in the embed-escape guard: one backslash escapes `!` (a
/// genuine wikilink, `embed:false`); two backslashes leave a live `!` (a genuine
/// embed). A single-byte lookbehind would drop the two-backslash embed.
#[test]
fn embed_escape_backslash_parity() {
    use mdstruct::Inline;
    let wikilink = |src: &str| {
        parse(src, &Options::default()).inlines.iter().find_map(|i| match i {
            Inline::Wikilink { page, embed, .. } => Some((page.clone(), *embed)),
            _ => None,
        })
    };
    // one backslash: `!` escaped → plain wikilink, not an embed.
    assert_eq!(wikilink("x \\![[Note]] y"), Some(("Note".to_string(), false)));
    // two backslashes: literal `\` + live `!` → genuine embed.
    assert_eq!(wikilink("x \\\\![[Note]] y"), Some(("Note".to_string(), true)));
}
