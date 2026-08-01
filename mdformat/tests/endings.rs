//! What stands in for the oracle the endings rule cannot have.
//!
//! Every other rewrite in this crate is gated by [`mdformat::structure_of`]:
//! rewrite, re-parse, and refuse unless the two parses match on kinds, node
//! attributes, rendered HTML and table source shape. `endings.rs` carries no
//! such gate, and its module docs argue why — the structure oracle **refuses**
//! this rewrite, and an oracle blind to the bytes it changes could never fail.
//! Both halves of that argument are asserted here rather than believed, because
//! "we decided not to guard this one" is exactly the sentence that should cost
//! a test.
//!
//! So this file measures what the guard would have measured, on specimens
//! covering every block shape the crate knows about:
//!
//! - the **block skeleton** and every **table's source shape** survive
//!   identically — the two signatures that carry no line-ending bytes at all;
//! - the **rendered HTML** survives identically once the carriage returns are
//!   read out of it the way an HTML parser reads them out of a document, which
//!   is the only reading under which comrak's `\r`-carrying output means
//!   anything — with exactly one exception, a code span crossing a line, where
//!   the rewrite moves comrak's render **onto** the CommonMark one;
//! - the **raw** oracle, unmodified, reports a difference for the specimens
//!   holding a literal — and that list is pinned, so nobody reinstates the gate
//!   without seeing which files it would decline.
//!
//! Specimens are byte literals for the reason `normal_form.rs`'s are: a
//! carriage return is one editor pass away from not being there. The corpus
//! cannot supply any of this — 0 of the vault's 1244 files hold a `\r`.

use mdformat::{Structure, structure_of, to_lf};

fn opts() -> mdstruct::Options {
    mdstruct::Options::default()
}

fn utf8(bytes: &[u8]) -> &str {
    std::str::from_utf8(bytes).expect("specimens are UTF-8")
}

/// Documents whose parse the rewrite must not disturb, one per block shape the
/// crate has a story about.
const SPECIMENS: &[(&str, &[u8])] = &[
    ("blocks", b"# H\r\n\r\npara one\r\n\r\n- a\r\n- b\r\n"),
    ("front-matter", b"---\r\ntitle: x\r\n---\r\n\r\n# H\r\n"),
    ("lone-cr", b"a\r## H\rbody\r"),
    ("fenced-code", b"```\r\ncode   \r\n\r\nmore\r\n```\r\n"),
    ("indented-code", b"    indented\r\n    code\r\n"),
    (
        "html-block",
        b"<div>\r\n  <p>x</p>\r\n</div>\r\n\r\nafter\r\n",
    ),
    ("table", b"| a | b |\r\n| --- | --- |\r\n| 1 | 2 |\r\n"),
    (
        "ragged-table",
        b"| a | b | c |\r\n| --- | --- | --- |\r\n| 1 | 2 |\r\n",
    ),
    ("block-quote", b"> quoted\r\n> lines\r\n\r\nafter\r\n"),
    ("hard-break", b"first  \r\nsecond\r\n"),
    ("setext", b"Title\r\n=====\r\n\r\nbody\r\n"),
    ("code-span", b"para with `co\r\nde` span\r\n"),
    (
        "link-reference-definition",
        b"[label]: https://example.com\r\n\r\nSee [label].\r\n",
    ),
    ("task-list", b"- [x] done\r\n- [ ] todo\r\n"),
    ("backslash-break", b"text\\\r\nbreak\r\n"),
    ("mixed", b"lf\ncrlf\r\ncr\rend\n"),
    ("bom", b"\xEF\xBB\xBF# H\r\n\r\nbody\r\n"),
];

fn signatures(source: &str) -> Structure {
    structure_of(source, &opts())
}

/// Every `\r` mapped to `\n`, which is what an HTML parser does to a document's
/// input stream before any element sees it. Comparing comrak's raw HTML output
/// would compare bytes no renderer ever distinguishes.
fn crs_read_as_html_reads_them(s: &str) -> String {
    to_lf(s).output
}

/// **The two signatures that carry no line-ending bytes.** The block skeleton
/// and every table's source shape must survive the rewrite byte-identically —
/// no block gained, lost, renested or reshaped. This is the part of the refused
/// oracle that is not refused, and it is the part that would catch a rewrite
/// that did more than it says.
#[test]
fn the_block_skeleton_and_every_table_shape_survive_identically() {
    for (name, input) in SPECIMENS {
        let src = utf8(input);
        let before = signatures(src);
        let after = signatures(&to_lf(src).output);
        assert_eq!(before.kinds, after.kinds, "{name}: block skeleton changed");
        assert_eq!(before.tables, after.tables, "{name}: table shape changed");
    }
}

/// **The render.** Read the carriage returns out of both sides the way an HTML
/// parser does, and the rendered documents are equal for every specimen but
/// one: each difference the raw oracle sees is a line ending inside a literal,
/// and a literal `\r` is a byte no renderer distinguishes from `\n`.
///
/// The exception is pinned as a list rather than skipped by name, so a second
/// shape that starts changing its render shows up here as a failing assertion
/// instead of joining a silent exemption.
#[test]
fn the_rendered_document_survives_once_the_html_is_read_as_html() {
    let changed: Vec<&str> = SPECIMENS
        .iter()
        .filter(|(_, input)| {
            let src = utf8(input);
            crs_read_as_html_reads_them(&signatures(src).html)
                != signatures(&to_lf(src).output).html
        })
        .map(|(name, _)| *name)
        .collect();
    assert_eq!(
        changed,
        vec!["code-span"],
        "only the code span may render differently — see \
         `the_one_render_the_rewrite_changes_it_repairs`"
    );
}

/// The one exception, quoted, and the argument that it is a repair.
///
/// CommonMark converts each line ending in a code span to **one space**, and
/// `\r\n` is one line ending, so `co de` is the conforming render. comrak
/// converts the `\n` and leaves the `\r` sitting in the text, so it renders
/// `co\r de` — two characters where the specification asks for one. The rewrite
/// therefore changes what a reader sees, in the direction of the specification,
/// and only for a code span that crosses a line with a CRLF in it.
///
/// It is also invisible in a browser either way: `<code>` is not `<pre>`, so
/// the run collapses to one space whichever byte is in it. Asserted rather than
/// argued because "the render changes" is the one claim in this file that would
/// otherwise sit only in a comment.
#[test]
fn the_one_render_the_rewrite_changes_it_repairs() {
    let crlf = utf8(b"para with `co\r\nde` span\r\n");
    let lf = to_lf(crlf).output;
    assert_eq!(
        signatures(crlf).html,
        "<p>para with <code>co\r de</code> span</p>\n",
        "comrak leaves the CR in the code span's text"
    );
    assert_eq!(
        signatures(&lf).html,
        "<p>para with <code>co de</code> span</p>\n",
        "one line ending becomes one space, as CommonMark specifies"
    );
}

/// **The refutation, asserted.** The structure oracle as it stands reports a
/// difference for exactly these specimens, because comrak stores line endings
/// verbatim inside a `CodeBlock`, `HtmlBlock` and `FrontMatter` literal and
/// prints them, and renders a code span's `\r` as a literal `\r`.
///
/// This list is why the oracle does not gate the rule: under a gate every one
/// of these files would be declined, the gap rule would rewrite their gaps to
/// LF anyway, and the output would mix two endings — the defect the rule exists
/// to remove, reintroduced by its own guard. Pinned so that reinstating the
/// gate means reading which files it refuses.
#[test]
fn the_structure_oracle_refuses_this_rewrite() {
    let refused: Vec<&str> = SPECIMENS
        .iter()
        .filter(|(_, input)| {
            let src = utf8(input);
            signatures(src)
                .diff(&signatures(&to_lf(src).output))
                .is_some()
        })
        .map(|(name, _)| *name)
        .collect();
    assert_eq!(
        refused,
        vec![
            "front-matter",
            "fenced-code",
            "indented-code",
            "html-block",
            "code-span"
        ],
        "the set of specimens the oracle refuses has moved"
    );
}

/// **The vacuity, asserted.** The obvious repair — an oracle blind to the bytes
/// the rule changes, in the shape of `Structure::tables`'s blindness to the
/// delimiter row's dash run — cannot fail on any input, because `to_lf` changes
/// only `\r` bytes and the blinding maps those out of both sides. A guard that
/// is silent by construction is a green light of unknown meaning, which is the
/// failure this crate has already shipped three times.
#[test]
fn an_oracle_blind_to_line_endings_is_silent_by_construction() {
    for (name, input) in SPECIMENS {
        let src = utf8(input);
        // Blind both sides by canonicalizing before parsing. On the right this
        // is a no-op; on the left it is the rewrite itself. There is nothing
        // left for the comparison to see.
        let blinded = signatures(&to_lf(src).output);
        let after = signatures(&to_lf(&to_lf(src).output).output);
        assert_eq!(blinded.diff(&after), None, "{name}");
    }
}

/// The rewrite is total: no output holds a carriage return, and a second pass
/// changes nothing. Weak on its own — it is the property `format`'s idempotence
/// tests already imply — and it is the one that states the ruling directly.
#[test]
fn no_output_holds_a_carriage_return() {
    for (name, input) in SPECIMENS {
        let once = to_lf(utf8(input)).output;
        assert!(!once.contains('\r'), "{name}: a CR survived");
        assert_eq!(to_lf(&once).output, once, "{name}: not a fixpoint");
    }
}
