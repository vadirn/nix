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
//! It also carries the one clause those three cannot reach: what the rule says
//! about a document that already holds LF endings. Every specimen above is
//! built around a `\r` so the rewrite has something to do, so the rule's
//! identity case needs its own fixtures and its own instrument — the report,
//! since an untouched document and an unexamined one are the same bytes. See
//! [`an_lf_clean_document_is_already_normal_for_this_rule`].
//!
//! Specimens are byte literals for the reason `normal_form.rs`'s are: a
//! carriage return is one editor pass away from not being there. The corpus
//! cannot supply any of this — 0 of the vault's 1244 files hold a `\r`.

use mdformat::{RuleRun, Structure, check, structure_of, to_lf};

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

/// Documents that already hold the normal form's one line ending, one per block
/// shape [`SPECIMENS`] covers. Every one of those is deliberately built around a
/// `\r`, so without these the rule's fixpoint clause has no specimen at all —
/// the corpus cannot supply one either, since a file with no `\r` exercises the
/// rewrite's identity case only by accident rather than by name.
///
/// `no-final-newline` is here on purpose: it is a document the *gap* rule
/// faults and this rule does not, which is what makes the claim below a claim
/// about the endings rule rather than about `check` agreeing with itself.
const LF_CLEAN: &[(&str, &[u8])] = &[
    ("blocks", b"# H\n\npara one\n\n- a\n- b\n"),
    ("front-matter", b"---\ntitle: x\n---\n\n# H\n"),
    ("fenced-code", b"```\ncode\n\nmore\n```\n"),
    ("indented-code", b"    indented\n    code\n"),
    ("html-block", b"<div>\n  <p>x</p>\n</div>\n\nafter\n"),
    ("table", b"| a   | b   |\n| --- | --- |\n| 1   | 2   |\n"),
    ("block-quote", b"> quoted\n> lines\n\nafter\n"),
    ("hard-break", b"first  \nsecond\n"),
    ("setext", b"Title\n=====\n\nbody\n"),
    ("code-span", b"para with `co\nde` span\n"),
    ("task-list", b"- [x] done\n- [ ] todo\n"),
    ("empty", b""),
    ("no-final-newline", b"no trailing newline"),
];

fn signatures(source: &str) -> Structure {
    structure_of(source, &opts())
}

/// The endings rule's own row of a [`check`] report, which is where this rule's
/// verdict on a document is readable apart from the other three.
fn endings_row(source: &str) -> RuleRun {
    let c = check(source, &opts()).expect("spans convert");
    c.rules
        .iter()
        .find(|r| r.rule == "endings")
        .expect("the endings rule is in RULES")
        .clone()
}

/// Every claim the rule makes about a document it leaves alone, in one place.
fn assert_reported_normal(name: &str, source: &str) {
    let r = endings_row(source);
    assert!(
        r.is_normal(),
        "{name}: the rule calls an LF-clean document abnormal"
    );
    assert_eq!(
        r.departures(),
        &[],
        "{name}: a departure was reported where there is no `\\r`"
    );
    assert!(r.declined.is_none(), "{name}: this rule declines nothing");
    assert!(r.exempt.is_empty(), "{name}: this rule exempts nothing");
    assert_eq!(
        r.yielded(),
        source,
        "{name}: the rule did not pass it through"
    );
    assert_eq!(
        r.accepted(),
        Some(source),
        "{name}: an unchanged document is still an accepted one"
    );
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
///
/// The fixpoint is asserted twice over, on the bytes and on the **report**: a
/// second pass that changed nothing but went on saying it would is a rule whose
/// predicate and whose rewrite disagree, and only the report can tell those two
/// apart — the bytes are identical either way.
#[test]
fn no_output_holds_a_carriage_return() {
    for (name, input) in SPECIMENS {
        let once = to_lf(utf8(input)).output;
        assert!(!once.contains('\r'), "{name}: a CR survived");
        assert_eq!(to_lf(&once).output, once, "{name}: not a fixpoint");
        assert_reported_normal(name, &once);
    }
}

/// **The fixpoint clause, for this rule and no other.** A document that already
/// holds LF endings is one the endings rule reports normal: no rewrite, no
/// departure, and its own input handed on to the next stage.
///
/// This is the one clause of the contract every other test in this file
/// deliberately cannot reach. Each [`SPECIMENS`] entry is built around a `\r`
/// so that the corrective clause has something to correct, and the corpus holds
/// no `\r` at all — so the rule's identity case was, until this fixture, a
/// thing the suite exercised only incidentally and asserted nowhere.
///
/// It is asserted on the report rather than on the bytes because the bytes
/// cannot carry it: `output == source` is what a rule that ran and found
/// nothing produces *and* what a rule that never ran produces. `is_normal`,
/// `departures` and `accepted` are the three places the difference shows.
///
/// Measured: an `EndingRule` that reports a document with no ending to rewrite
/// as **declined** rather than normal — a lie the bytes cannot carry, since a
/// declined rule yields its input — turns this test red, along with the report
/// half of `no_output_holds_a_carriage_return` and two report-level tests
/// elsewhere. 179 of 183 still pass, and no byte assertion in the crate is
/// among the four.
#[test]
fn an_lf_clean_document_is_already_normal_for_this_rule() {
    for (name, input) in LF_CLEAN {
        let src = utf8(input);
        assert!(
            !src.contains('\r'),
            "{name}: an LF-clean specimen must hold no carriage return"
        );
        let e = to_lf(src);
        assert_eq!(
            e.changes,
            vec![],
            "{name}: an ending was reported changed where every ending is already LF"
        );
        assert!(!e.changed(), "{name}: the rewrite claims to have moved");
        assert_eq!(
            e.output, src,
            "{name}: the rewrite is not the identity here"
        );
        assert_reported_normal(name, src);
    }
}
