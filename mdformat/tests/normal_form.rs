//! **Clause-A fixtures**: ill-formed input paired with a *hand-written*
//! expected output, one per rule clause, asserted byte for byte.
//!
//! # Why this file exists
//!
//! `format.rs` derives its predicate from its rules: a document is normal for a
//! rule exactly when the rule's own yield for it is the document unchanged.
//! That is the right choice — a hand-written predicate would reimplement
//! `content_spans` and would have to reproduce every declination by hand — but
//! substitute the derivation into the formatter's two-clause contract and both
//! clauses lose their teeth:
//!
//! - *fixpoint* ("already-normal input is unchanged") becomes a tautology;
//! - *corrective* ("the output is normal") becomes `format(format(f)) ==
//!   format(f)`, which is idempotence and nothing more.
//!
//! **`format = identity` satisfies both, perfectly.** Every document normal,
//! zero departures, a green suite. Nothing inside the tool can tell a correct
//! formatter from one that does nothing at all.
//!
//! So the standard of correctness has to come from outside the tool, and this
//! file is it. Every `expected` below was written by hand from the rule's
//! stated normal form — the tables in `normalize.rs` and `table.rs` — and never
//! by running the formatter and pasting its output, which would only relocate
//! the vacuity. An expected output a person wrote is the one artifact here that
//! can say *the tool did nothing and should have*.
//!
//! This matters because the same failure shape has already landed three times
//! in this crate: reassembly equality (a passthrough printer satisfies it
//! trivially), the byte-partition oracle (unary — it passed 167 of 167
//! deliberately destroyed documents), and now the derived predicate. Each was
//! green for a reason unrelated to the property it claimed.
//!
//! # How this file proves it can go red
//!
//! `negative_controls.rs` is the model: asserted failures beside passing causal
//! controls. The section at the foot does the same for this suite —
//! [`the_identity_formatter_fails_this_suite`] names the fixtures a do-nothing
//! formatter loses, and each `..._is_not_the_normal_form` test pins a plausible
//! *wrong* normal form that the real one must not produce. A fixture suite that
//! cannot demonstrate its own red state is one more green light of unknown
//! meaning.
//!
//! The red state was also **measured**, by mutating the crate and rerunning
//! this file:
//!
//! | mutation | result |
//! | --- | --- |
//! | `format` returns its input (the identity formatter) | 13 of 17 tests fail, 29 of 32 fixtures depart |
//! | `MIN_WIDTH` 3 → 1 | 7 of 17 tests fail, 6 of 32 fixtures depart |
//!
//! The first row is the whole argument in one number, and its *other* half is
//! the more telling one: under the identity mutant
//! [`every_expectation_is_a_fixpoint`] and [`formatting_twice_changes_nothing`]
//! **still pass**. Idempotence is worth locking, and it is not a standard of
//! correctness. Only the hand-written bytes notice.
//!
//! # Idempotence, locked at both levels
//!
//! A probe measured the composition over the 1244-file vault and found the
//! second pass changed nothing. That is evidence over one corpus, not a proof,
//! and nothing in the suite enforced it. Here it is enforced per fixture
//! ([`every_expectation_is_a_fixpoint`], [`formatting_twice_changes_nothing`]);
//! `corpus.sh` enforces it over the corpus, as a second phase that runs by
//! default (`--fixpoint-only` skips it) under the same accounting guard the
//! first phase carries.
//!
//! Commutativity of the gap and table rules is deliberately **not** asserted
//! anywhere: it is a corpus-contingent observation, and `format.rs` fixes the
//! pipeline order at endings → gaps → tables on purpose. The endings rule's
//! place at the head is load-bearing rather than contingent — it is what keeps
//! a carriage return out of the other two rules' inputs.
//!
//! # Coverage the corpus cannot give
//!
//! A probe measured 0 whole-document declinations across 1244 vault files, so
//! the decline path fires only here. The same holds for an unterminated fence
//! at EOF and for an emoji in a table cell — the one place the display-width
//! measure and the character count disagree. Every one of those is a fixture
//! below.
//!
//! **Line endings are the extreme case**: 0 of those 1244 files hold a carriage
//! return, so the entire endings rule — every clause of it — is exercised by
//! this file and by `tests/endings.rs` and nowhere else. That is also why its
//! fixtures had to be *rewritten* rather than added. Two of them predate the
//! rule and pinned the shape it removed: the gap rule stated its separators as
//! LF literals, so it rewrote the endings it could reach and left the ones
//! inside a span, and a CRLF file came out holding **both** endings. That
//! output was pinned deliberately, so that adopting a line-ending policy would
//! have to be a visible edit rather than silent drift. This is that edit; the
//! withdrawn form is now an asserted failure, in
//! [`preserving_a_span_interior_crlf_is_not_the_normal_form`].
//!
//! Every specimen is an embedded byte literal, for the reason `table.rs`'s
//! fixtures are: these shapes are *made of whitespace*, and a specimen on disk
//! is one `autoformat` pass away from no longer being the specimen.

use mdformat::{Format, check, format};

fn opts() -> mdstruct::Options {
    mdstruct::Options::default()
}

fn utf8(bytes: &[u8]) -> &str {
    std::str::from_utf8(bytes).expect("fixtures are UTF-8")
}

fn formatted(source: &str) -> Format {
    format(source, &opts()).expect("spans convert")
}

/// One clause-A fixture: an input, and what a person says the formatter owes
/// for it.
struct Fixture {
    /// Test-report identifier.
    name: &'static str,
    /// The clause of the stated normal form this fixture reads off, quoted
    /// closely enough that a reader can check the expectation against the
    /// module docs of `normalize.rs` or `table.rs` without running anything.
    clause: &'static str,
    input: &'static [u8],
    /// **Hand-written.** See the module docs.
    expected: &'static [u8],
}

impl Fixture {
    /// Whether this fixture can tell `format` apart from `identity`. False for
    /// the declined constructs, whose whole content is that the formatter
    /// leaves them alone.
    fn discriminating(&self) -> bool {
        self.input != self.expected
    }
}

/// The fixtures, in rule order: gaps, then endings, then tables, then all at
/// once, then the constructs a rule declines.
const FIXTURES: &[Fixture] = &[
    // ---------------------------------------------------------------- gaps --
    Fixture {
        name: "gaps: a run of blank lines collapses to one",
        clause: "between any other two top-level blocks -> exactly one blank line",
        input: b"# Title\n\n\n\nOne paragraph.\n\n\n## Section\n\ntail\n",
        expected: b"# Title\n\nOne paragraph.\n\n## Section\n\ntail\n",
    },
    Fixture {
        // The same expectation reached from the other side: the normal form is
        // a form, not a direction of travel.
        name: "gaps: a missing blank line is inserted",
        clause: "between any other two top-level blocks -> exactly one blank line",
        input: b"# Title\nOne paragraph.\n## Section\ntail\n",
        expected: b"# Title\n\nOne paragraph.\n\n## Section\n\ntail\n",
    },
    Fixture {
        name: "gaps: leading blank lines are deleted",
        clause: "before the first block -> \"\"",
        input: b"\n\n\n# Title\n\nbody\n",
        expected: b"# Title\n\nbody\n",
    },
    Fixture {
        name: "gaps: the file ends with exactly one newline",
        clause: "after the last block -> \"\\n\"",
        input: b"# Title\n\nbody\n\n\n",
        expected: b"# Title\n\nbody\n",
    },
    Fixture {
        name: "gaps: a missing final newline is added",
        clause: "after the last block -> \"\\n\"",
        input: b"# Title\n\nbody",
        expected: b"# Title\n\nbody\n",
    },
    Fixture {
        // Rule 4 (no trailing whitespace on a blank line) needs no clause of
        // its own because a gap is regenerated rather than edited. This is
        // what that claim looks like as bytes: three differently-padded blank
        // lines, one blank line out.
        name: "gaps: whitespace-only lines in a gap are regenerated, not edited",
        clause: "a gap is regenerated, so whatever its blank lines carried is gone",
        input: b"# Title\n   \n\t\n \t \nbody\n",
        expected: b"# Title\n\nbody\n",
    },
    Fixture {
        // The counterpart, and the boundary of the clause above: trailing
        // whitespace on a *content* line is span interior (content_span step 3
        // extends the span back over it), so the rule is silent about it. An
        // indented code block's literal is `"code   \n"`, and this is the
        // property that keeps it intact.
        name: "gaps: trailing whitespace on a content line is out of scope and survives",
        clause: "step 3 extends the span right to the last line's content end",
        input: b"# Title\n\n\nbody   \n",
        expected: b"# Title\n\nbody   \n",
    },
    Fixture {
        // Load-bearing whitespace, case 1: two spaces at end of line are a
        // hard line break, and they sit inside the paragraph's span.
        name: "gaps: a hard line break inside a paragraph survives",
        clause: "span interiors are unreachable; only gap bytes are rewritten",
        input: b"first line  \nsecond line\n\n\ntail\n",
        expected: b"first line  \nsecond line\n\ntail\n",
    },
    Fixture {
        // Load-bearing whitespace, case 2: the blank line between the items is
        // what makes the list loose, and it is span interior. Deleting it
        // would change the rendered HTML of 2532 corpus lists.
        name: "gaps: a loose list keeps the interior blank line that makes it loose",
        clause: "top-level gaps only; no recursion into containers",
        input: b"# H\n\n\n- alpha\n\n- beta\n\n\ntail\n",
        expected: b"# H\n\n- alpha\n\n- beta\n\ntail\n",
    },
    Fixture {
        // The other half of the same pair: a tight list must not gain the
        // blank lines the top-level rule would emit between blocks.
        name: "gaps: a tight list gains no blank lines between its items",
        clause: "top-level gaps only; no recursion into containers",
        input: b"# H\n\n\n- a\n- b\n- c\n\n\ntail\n",
        expected: b"# H\n\n- a\n- b\n- c\n\ntail\n",
    },
    Fixture {
        // Load-bearing whitespace, case 3: the newline between the text and
        // the underline is span interior. Emitting a blank line there would
        // turn one heading into a paragraph and a thematic break.
        name: "gaps: a setext underline stays attached to its heading",
        clause: "span interiors are unreachable; only gap bytes are rewritten",
        input: b"Title\n=====\n\n\nbody\n",
        expected: b"Title\n=====\n\nbody\n",
    },
    Fixture {
        // A blank line inside a block quote is `>`, not empty — the rule's
        // output alphabet is container-dependent, which is one of the two
        // measured reasons it does not recurse. The `>` line must survive.
        name: "gaps: a blank quote line inside a block quote is interior",
        clause: "top-level gaps only; no recursion into containers",
        input: b"# H\n\n\n> one\n>\n> two\n\n\ntail\n",
        expected: b"# H\n\n> one\n>\n> two\n\ntail\n",
    },
    Fixture {
        name: "gaps: blank lines inside a fenced code block are interior",
        clause: "span interiors are unreachable; only gap bytes are rewritten",
        input: b"# H\n\n\n```\n\ncode\n\n```\n\n\ntail\n",
        expected: b"# H\n\n```\n\ncode\n\n```\n\ntail\n",
    },
    Fixture {
        // The content_span step-2 case: comrak reports a top-level indented
        // code block starting at column 5, so its four-space indent is outside
        // the raw span and would fall in the gap. Extending the span left to
        // the line start is what keeps the indent — and with it the block's
        // identity as code.
        name: "gaps: an indented code block keeps its indent and its interior blank line",
        clause: "step 2 extends the span left to the line start",
        input: b"# H\n\n\n    code\n\n    more\n\n\ntail\n",
        expected: b"# H\n\n    code\n\n    more\n\ntail\n",
    },
    Fixture {
        name: "gaps: exactly one blank line follows front matter",
        clause: "after frontmatter -> \"\\n\\n\" (exactly one blank line)",
        input: b"---\nk: v\n---\n# H\n\nbody\n",
        expected: b"---\nk: v\n---\n\n# H\n\nbody\n",
    },
    // ------------------------------------------------------------ endings --
    Fixture {
        // Zero corpus exposure: 0 of the vault's 1244 files hold a carriage
        // return, so every fixture in this section is the only exercise its
        // clause gets. Two rules agree on this one — the gap rule states its
        // separators as LF literals, and the endings rule would rewrite them
        // anyway — which is why it is not the discriminating case.
        name: "endings: a CRLF document comes out LF throughout",
        clause: "\"\\r\\n\" -> \"\\n\"",
        input: b"# Title\r\n\r\n\r\nbody\r\n",
        expected: b"# Title\n\nbody\n",
    },
    Fixture {
        // The discriminating case, and the reason this rule exists. The CRLF
        // between two lines of one paragraph is span **interior**, so no gap
        // rule reaches it; before the endings rule this input formatted to
        // `"first\r\nsecond\n\ntail\n"`, with two line endings in one file and
        // no clause of any normal form asking for it. That output is now
        // refused by name, in
        // `preserving_a_span_interior_crlf_is_not_the_normal_form`.
        name: "endings: a CRLF inside a paragraph is span interior and is rewritten anyway",
        clause: "\"\\r\\n\" -> \"\\n\", every line ending, span interior included",
        input: b"first\r\nsecond\r\n\r\n\r\ntail\r\n",
        expected: b"first\nsecond\n\ntail\n",
    },
    Fixture {
        // The other row of the endings table. A lone `\r` is a CommonMark line
        // ending too — comrak agrees, which
        // `fixpoint.rs::lone_cr_is_a_line_ending_for_comrak_too` pins against a
        // real parse — so these three lines are a paragraph, a heading and a
        // paragraph, and the gap rule puts one blank line between each pair.
        name: "endings: a lone CR is a line ending and becomes LF",
        clause: "a lone \"\\r\" -> \"\\n\"",
        input: b"a\r## H\rbody\r",
        expected: b"a\n\n## H\n\nbody\n",
    },
    Fixture {
        // Span interior at its most load-bearing: the bytes between the fences
        // are a code block's *literal*, which `structure.rs` deliberately
        // refuses to trim because they are content. The endings rule rewrites
        // them regardless — a line ending inside a code block is still a line
        // ending — and this is exactly the shape whose `rich` and `html`
        // signatures the structure oracle reports as changed, which is why that
        // oracle does not gate this rule. See `tests/endings.rs`.
        name: "endings: a CRLF inside a fenced code block becomes LF",
        clause: "\"\\r\\n\" -> \"\\n\", every line ending, code-block literals included",
        input: b"# H\r\n\r\n```\r\ncode\r\n```\r\n",
        expected: b"# H\n\n```\ncode\n```\n",
    },
    Fixture {
        // All three endings in one document, which is the acceptance condition
        // stated as bytes: whatever a file mixes, the output holds one ending.
        // `lf\ncrlf` is one paragraph and `cr\nend` is another, so the blank
        // line between them is the only gap.
        name: "endings: a document mixing all three endings comes out with one",
        clause: "\"\\r\\n\" -> \"\\n\", a lone \"\\r\" -> \"\\n\", \"\\n\" -> \"\\n\"",
        input: b"lf\ncrlf\r\n\r\ncr\rend\n",
        expected: b"lf\ncrlf\n\ncr\nend\n",
    },
    // -------------------------------------------------------------- tables --
    Fixture {
        // Width 1 in both columns, floored to 3; the trailing unaligned column
        // takes the separator space and the closing pipe and nothing else,
        // while its delimiter cell still runs the full computed width.
        name: "tables: every column is padded to its width, floored at 3",
        clause: "a column's width is its widest cell, floored at 3",
        input: b"| a | b |\n| --- | --- |\n| 1 | 2 |\n",
        expected: b"| a   | b |\n| --- | --- |\n| 1   | 2 |\n",
    },
    Fixture {
        // The direction a do-nothing formatter cannot fake and a
        // padding-only one cannot either: cells and the delimiter run must
        // *shrink* to the column width.
        name: "tables: over-wide cells and delimiters shrink to the column width",
        clause: "each cell is \"|\" + \" \" + content + fill + \" \"; fill is exact",
        input: b"|   key   |   value   |\n| ------- | --------- |\n| a       | longer    |\n",
        expected: b"| key | value |\n| --- | ------ |\n| a   | longer |\n",
    },
    Fixture {
        // All three alignments at once. Column 3 is right-aligned, so the
        // trailing-column exemption does not apply to it: an alignment means
        // nothing without the fill that realizes it. The centre column's odd
        // fill goes right (`left = fill / 2`).
        name: "tables: alignment places the fill and the delimiter colons",
        clause: "fill right for none/left, left for right, split for centre",
        input: b"| l | c | r |\n| :-- | :-: | --: |\n| a | bb | ccc |\n",
        expected: b"| l   |  c  |   r |\n| :-- | :-: | --: |\n| a   | bb  | ccc |\n",
    },
    Fixture {
        // Zero corpus exposure for this width: `\|` is measured over the
        // source bytes, escapes intact, so it counts 2 and the column is 4
        // wide. Measuring the rendered text would give 3.
        name: "tables: an escaped pipe counts two columns toward the width",
        clause: "a cell's width is measured over its source bytes, escapes intact",
        input: b"| a | b |\n| --- | --- |\n| x\\|y | z |\n",
        expected: b"| a    | b |\n| ---- | --- |\n| x\\|y | z |\n",
    },
    Fixture {
        // The one place the three candidate measures disagree. Two U+1F389
        // (PARTY POPPER) occupy 4 terminal columns and 2 characters and 8
        // bytes; the column must come out 4 wide. `\xF0\x9F\x8E\x89` is one
        // U+1F389, written as bytes so the specimen survives any editor.
        name: "tables: an emoji cell is measured in terminal columns",
        clause: "the measure is unicode-width display width, not bytes or chars",
        input: b"| f | note |\n| --- | --- |\n| \xF0\x9F\x8E\x89\xF0\x9F\x8E\x89 | done |\n",
        expected:
            b"| f    | note |\n| ---- | ---- |\n| \xF0\x9F\x8E\x89\xF0\x9F\x8E\x89 | done |\n",
    },
    // -------------------------------------------------------- every rule ---
    Fixture {
        // One invocation, gaps and tables, on a document ill-formed under each.
        // Column 2 holds "22" (width 2), floored to 3, which is why its
        // delimiter is three dashes and not two.
        name: "both: a gap collapse and a table padding in one pass",
        clause: "format applies every rule in RULES, gaps then tables",
        input: b"# H\n\n\n| a | b |\n| --- | --- |\n| 1 | 22 |\n\n\npara\n",
        expected: b"# H\n\n| a   | b |\n| --- | --- |\n| 1   | 22 |\n\npara\n",
    },
    Fixture {
        // All three rules in one pass, on a document ill-formed under each.
        // The pipeline order is deliberately *not* observable here — putting
        // the endings rule last would reach the same bytes, since the gap rule
        // regenerates its separators as LF either way. What the head position
        // buys is that no later rule ever has to have a story for a carriage
        // return, which is a claim about the code rather than about the output,
        // and so is not the kind of thing a fixture can pin.
        name: "all: line endings, a gap collapse and a table padding in one pass",
        clause: "format applies every rule in RULES, endings then gaps then tables",
        input: b"# H\r\n\r\n\r\n| a | b |\r\n| --- | --- |\r\n| 1 | 22 |\r\n\r\n\r\npara\r\n",
        expected: b"# H\n\n| a   | b |\n| --- | --- |\n| 1   | 22 |\n\npara\n",
    },
    // ------------------------------------------------------- declinations --
    Fixture {
        // Fixture-only territory: 0 whole-document declinations across 1244
        // vault files. A ragged row makes `pad` decline the table — comrak
        // does not model raggedness, so padding it would either delete the
        // long row's overflow or materialize the short row's missing cell.
        // The document is therefore *normal* while holding an unpadded table.
        name: "declined: a ragged table is left verbatim",
        clause: "a table with a ragged row is skipped, and its whole table with it",
        input: b"| a | b | c |\n| --- | --- | --- |\n| 1 | 2 |\n",
        expected: b"| a | b | c |\n| --- | --- | --- |\n| 1 | 2 |\n",
    },
    Fixture {
        // The causal control for the fixture above, and the reason it is
        // stored as a fixture rather than an aside: the same table with one
        // cell added to the short row. The single differing factor is that
        // row's cell count, and the padding fires.
        name: "declined (control): the same table made rectangular is padded",
        clause: "a column's width is its widest cell, floored at 3",
        input: b"| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n",
        expected: b"| a   | b   | c |\n| --- | --- | --- |\n| 1   | 2   | 3 |\n",
    },
    Fixture {
        // The gap rule's structure guard, on the shape that motivated it:
        // deleting the leading blank lines promotes the `---` into front
        // matter, which is a different parse, so the rewrite is refused and
        // the rule yields its input. A refused document is normal — the
        // declination and the exemption are the same fact.
        name: "declined: a rewrite that would promote `---` into front matter",
        clause: "the rewrite is refused when it changes the parse",
        input: b"\n\n---\nk: v\n---\n",
        expected: b"\n\n---\nk: v\n---\n",
    },
    Fixture {
        // The other shape with zero corpus exposure: an unterminated fence at
        // EOF absorbs the blank lines after it into its literal, so the
        // trailing-newline clause would delete code-block *content*. The block
        // skeleton is identical either way — one codeBlock — which is why the
        // structure oracle carries a rich signature and an HTML one rather
        // than comparing kinds. The rewrite is refused, and the document is
        // therefore normal while ending in three newlines.
        name: "declined: an unterminated fence whose literal holds the trailing blank lines",
        clause: "the rewrite is refused when it changes the parse",
        input: b"```\ncode\n\n\n",
        expected: b"```\ncode\n\n\n",
    },
    Fixture {
        // The causal control for the fixture above: close the fence and the
        // same trailing blank lines collapse to one newline. The single
        // differing factor is the closing fence — with it, the blank lines are
        // gap bytes rather than code-block content.
        name: "declined (control): closing the fence makes the same trailing lines a gap",
        clause: "after the last block -> \"\\n\"",
        input: b"```\ncode\n```\n\n\n",
        expected: b"```\ncode\n```\n",
    },
];

/// **Clause A.** Every fixture's formatted output equals the bytes a person
/// wrote for it. This is the only assertion in the crate that a `format` doing
/// nothing at all would fail.
#[test]
fn every_fixture_formats_to_its_hand_written_expectation() {
    let mut wrong = Vec::new();
    for f in FIXTURES {
        let got = formatted(utf8(f.input)).output;
        let want = utf8(f.expected);
        if got != want {
            wrong.push(format!(
                "\n{}\n  clause:   {}\n  input:    {:?}\n  expected: {:?}\n  got:      {:?}",
                f.name,
                f.clause,
                utf8(f.input),
                want,
                got
            ));
        }
    }
    assert!(
        wrong.is_empty(),
        "{} of {} fixtures departed from their hand-written expectation:{}",
        wrong.len(),
        FIXTURES.len(),
        wrong.join("")
    );
}

/// **Idempotence, per fixture.** Formatting a hand-written expectation again
/// changes nothing, and the derived predicate agrees it is normal.
///
/// Read alone this is weak — `identity` passes it. Read beside the test above
/// it is the corrective clause with the vacuity removed: the bytes it calls a
/// fixpoint are bytes a person chose, not bytes the tool emitted.
#[test]
fn every_expectation_is_a_fixpoint() {
    for f in FIXTURES {
        let want = utf8(f.expected);
        let again = formatted(want);
        assert_eq!(
            again.output, want,
            "{}: the hand-written normal form is not a fixpoint",
            f.name
        );
        assert!(
            !again.changed,
            "{}: `changed` disagrees with the bytes",
            f.name
        );
        let c = check(want, &opts()).expect("spans convert");
        assert!(
            c.is_normal(),
            "{}: `check` calls the hand-written normal form abnormal: {:?}",
            f.name,
            c.departures().collect::<Vec<_>>()
        );
    }
}

/// **Idempotence, per fixture, from the input side.** `format(format(f)) ==
/// format(f)` for every fixture input, ill-formed ones included. Distinct from
/// the test above: that one starts from a normal form, this one starts from a
/// document with departures and pins that one pass is enough to reach the
/// fixpoint — a rule that alternated between two forms would fail here.
#[test]
fn formatting_twice_changes_nothing() {
    for f in FIXTURES {
        let once = formatted(utf8(f.input)).output;
        let twice = formatted(&once);
        assert_eq!(
            twice.output, once,
            "{}: the second pass changed the first pass's output",
            f.name
        );
        assert!(
            !twice.changed,
            "{}: `changed` set on the second pass",
            f.name
        );
    }
}

/// Every rule that declined a document yields its input verbatim, and reports
/// no departure while doing so.
///
/// The declining fixtures are the only exercise this path gets: a probe
/// measured 0 whole-document declinations across the 1244-file vault, so
/// without these the decline branch of `RuleRun::new` is dead code in every
/// run that is not this test.
#[test]
fn the_declining_fixtures_actually_decline() {
    let ragged = utf8(b"| a | b | c |\n| --- | --- | --- |\n| 1 | 2 |\n");
    let promoted = utf8(b"\n\n---\nk: v\n---\n");
    let fence = utf8(b"```\ncode\n\n\n");

    // A per-table declination: the table rule runs, and exempts one construct.
    let c = check(ragged, &opts()).expect("spans convert");
    assert!(c.is_normal(), "{:?}", c.departures().collect::<Vec<_>>());
    assert_eq!(c.exempt().count(), 1, "the ragged table must be exempt");
    assert_eq!(
        c.declined().count(),
        0,
        "no rule declines the whole document"
    );

    // Whole-document declinations: the gap rule refuses its own rewrite, on
    // two different shapes and for the same stated reason.
    for src in [promoted, fence] {
        let c = check(src, &opts()).expect("spans convert");
        assert!(c.is_normal(), "{:?}", c.departures().collect::<Vec<_>>());
        let declined: Vec<_> = c.declined().map(|(rule, _)| rule).collect();
        assert_eq!(declined, vec!["gaps"], "the gaps rule must refuse {src:?}");
    }
}

// ---------------------------------------------------------------------------
// Proving the suite can go red
//
// `negative_controls.rs` holds asserted failures beside passing causal
// controls, for the reason this section exists: a green suite means nothing
// until someone has shown what turns it red. Every test below states a
// formatter that would fail, or a normal form the real one must not produce.
// ---------------------------------------------------------------------------

/// A formatter that does nothing — the one that satisfies every internal
/// property in `format.rs` and is nonetheless wrong.
fn identity(source: &str) -> String {
    source.to_string()
}

/// **The red state, named.** `identity` passes the derived predicate, the
/// corrective clause, the fixpoint clause and both idempotence tests above. It
/// fails these fixtures, and this test lists exactly which — so the suite's
/// discriminating power is a number in the report rather than a hope.
#[test]
fn the_identity_formatter_fails_this_suite() {
    let lost: Vec<&str> = FIXTURES
        .iter()
        .filter(|f| identity(utf8(f.input)) != utf8(f.expected))
        .map(|f| f.name)
        .collect();
    assert_eq!(
        lost.len(),
        FIXTURES.iter().filter(|f| f.discriminating()).count(),
        "`discriminating` must mean exactly `identity` fails it"
    );
    assert!(
        lost.len() >= 20,
        "only {} fixtures can tell `format` from `identity`: {lost:#?}",
        lost.len()
    );
    // And the converse, so the count above cannot be inflated by a fixture
    // that merely differs: every discriminating fixture is one the real
    // formatter gets right, which is what makes `identity`'s failure on it a
    // defect rather than a disagreement.
    for f in FIXTURES.iter().filter(|f| f.discriminating()) {
        assert_eq!(
            formatted(utf8(f.input)).output,
            utf8(f.expected),
            "{}",
            f.name
        );
    }
}

/// Every non-discriminating fixture is a declination, and every declination is
/// non-discriminating. Without this, a fixture whose expectation was quietly
/// weakened to its input would slip out of the count above and be missed.
#[test]
fn only_the_declining_fixtures_leave_their_input_alone() {
    let passive: Vec<&str> = FIXTURES
        .iter()
        .filter(|f| !f.discriminating())
        .map(|f| f.name)
        .collect();
    assert_eq!(
        passive,
        vec![
            "declined: a ragged table is left verbatim",
            "declined: a rewrite that would promote `---` into front matter",
            "declined: an unterminated fence whose literal holds the trailing blank lines",
        ],
        "a fixture that leaves its input alone must say why in its name"
    );
}

/// **Asserted failure (a).** The uncapped padder — the one that pads every
/// column, trailing included — is a plausible normal form, and it is not this
/// one. It cost 261 920 added spaces over the corpus against 31 648 for the
/// exemption, which is why the exemption exists.
#[test]
fn padding_the_trailing_column_is_not_the_normal_form() {
    let src = utf8(b"| a | b |\n| --- | --- |\n| 1 | 2 |\n");
    let uncapped = utf8(b"| a   | b   |\n| --- | --- |\n| 1   | 2   |\n");
    let got = formatted(src).output;
    assert_ne!(
        got, uncapped,
        "the trailing unaligned column must lose its fill"
    );
    assert_eq!(got, utf8(b"| a   | b |\n| --- | --- |\n| 1   | 2 |\n"));
}

/// The causal control for (a): make the trailing column right-aligned and its
/// fill comes back — on the left, where the alignment puts it. The single
/// differing factor is the alignment marker, which is the exemption's own
/// stated condition: an alignment means nothing without the fill that
/// realizes it.
#[test]
fn a_right_aligned_trailing_column_keeps_its_fill() {
    let src = utf8(b"| a | b |\n| --- | ---: |\n| 1 | 2 |\n");
    assert_eq!(
        formatted(src).output,
        utf8(b"| a   |   b |\n| --- | --: |\n| 1   |   2 |\n")
    );
}

/// **Asserted failure (b).** A minimum column width of 1 — the width the cells
/// alone would give — is the other plausible normal form. `MIN_WIDTH` is 3 so
/// the delimiter row always has room for `---` and for `:-:`.
#[test]
fn a_column_narrower_than_three_is_not_the_normal_form() {
    let src = utf8(b"| a | b |\n| - | - |\n| 1 | 2 |\n");
    let unfloored = utf8(b"| a | b |\n| - | - |\n| 1 | 2 |\n");
    let got = formatted(src).output;
    assert_ne!(got, unfloored, "the floor of 3 must widen this table");
    assert_eq!(got, utf8(b"| a   | b |\n| --- | --- |\n| 1   | 2 |\n"));
}

/// **Asserted failure (c).** Counting characters instead of terminal columns
/// is the measure that agrees with display width everywhere in the corpus
/// *except* on emoji — so this is the only specimen that can refute it, and
/// there is none like it in the vault. Under a character count the two poppers
/// measure 2, the column falls to the floor of 3, and the delimiter loses a
/// dash.
#[test]
fn character_count_is_not_the_width_measure() {
    let src = utf8(b"| f | note |\n| --- | --- |\n| \xF0\x9F\x8E\x89\xF0\x9F\x8E\x89 | done |\n");
    let by_chars =
        utf8(b"| f   | note |\n| --- | ---- |\n| \xF0\x9F\x8E\x89\xF0\x9F\x8E\x89 | done |\n");
    let got = formatted(src).output;
    assert_ne!(
        got, by_chars,
        "the width must be terminal columns, not chars"
    );
    assert_eq!(
        got,
        utf8(b"| f    | note |\n| ---- | ---- |\n| \xF0\x9F\x8E\x89\xF0\x9F\x8E\x89 | done |\n")
    );
}

/// The causal control for (c): replace the two poppers with two ASCII letters,
/// whose display width and character count agree, and the two candidate
/// measures produce the same bytes. The single differing factor is the
/// codepoints' width, not the cell's position or the table's shape.
#[test]
fn an_ascii_cell_of_the_same_length_cannot_discriminate_the_measures() {
    let src = utf8(b"| f | note |\n| --- | --- |\n| xy | done |\n");
    assert_eq!(
        formatted(src).output,
        utf8(b"| f   | note |\n| --- | ---- |\n| xy  | done |\n")
    );
}

/// **Asserted failure (d).** Two blank lines between top-level blocks is what
/// the corpus is full of and it is not the normal form. Stated as a refusal so
/// that a rule which merely *bounded* the gap rather than regenerating it
/// would fail here.
#[test]
fn more_than_one_blank_line_between_blocks_is_not_the_normal_form() {
    let src = utf8(b"# H\n\n\n\npara\n");
    assert_ne!(formatted(src).output, utf8(b"# H\n\n\npara\n"));
    assert_eq!(formatted(src).output, utf8(b"# H\n\npara\n"));
}

/// **Asserted failure (e).** Leaving a span-interior CRLF alone is what this
/// crate did until the endings rule landed, and it is not a normal form at all:
/// the gap rule rewrote the endings it could reach and left the ones it could
/// not, so the output held **both**. Pinned as a refusal, with the exact bytes
/// that used to come out, so reinstating span-interior CRLF as policy is a
/// deliberate act with a red test attached.
#[test]
fn preserving_a_span_interior_crlf_is_not_the_normal_form() {
    let src = utf8(b"first\r\nsecond\r\n\r\n\r\ntail\r\n");
    let mixed = utf8(b"first\r\nsecond\n\ntail\n");
    let got = formatted(src).output;
    assert_ne!(got, mixed, "the output must not mix two line endings");
    assert_eq!(got, utf8(b"first\nsecond\n\ntail\n"));
    assert!(
        !got.contains('\r'),
        "no formatted output may hold a carriage return"
    );
}

/// The causal control for (e): the same two paragraph lines with LF endings.
/// The single differing factor is the ending bytes — nothing about the
/// paragraph, the gap, or the block skeleton — and the same normal form comes
/// out, which is what makes the CRLF input's old output a defect rather than a
/// second legitimate form.
#[test]
fn the_same_document_with_lf_endings_reaches_the_same_normal_form() {
    let src = utf8(b"first\nsecond\n\n\ntail\n");
    assert_eq!(formatted(src).output, utf8(b"first\nsecond\n\ntail\n"));
}

/// **The check half of the ruling.** `--check` must call a CRLF file abnormal,
/// and must locate the departure. A formatter whose check passes a file its own
/// `format` would rewrite is the vacuity this whole file exists to close, so it
/// is asserted rather than left to the derived predicate's good behavior.
#[test]
fn check_reports_a_crlf_file_as_departing_from_normal_form() {
    let src = utf8(b"# Title\r\n\r\nfirst\r\nsecond\r\n");
    let c = check(src, &opts()).expect("spans convert");
    assert!(!c.is_normal(), "a CRLF file is not in normal form");
    // One departure per ending, in the source's own coordinates: L1:8 is the
    // `\r` after `# Title`, L2:1 the blank line's, L3:6 after `first`, L4:7
    // after `second`.
    assert_eq!(
        c.departures()
            .filter(|(rule, _)| *rule == "endings")
            .map(|(_, d)| (d.line, d.column))
            .collect::<Vec<_>>(),
        vec![(1, 8), (2, 1), (3, 6), (4, 7)]
    );
    assert_eq!(formatted(src).output, utf8(b"# Title\n\nfirst\nsecond\n"));
}

/// The sharp half of the same claim: a file whose **gaps** are already LF and
/// whose only CRLF is span interior. Every other rule finds it normal — this is
/// the file the old `check` passed while the old `format` rewrote it, which is
/// precisely the vacuity a formatter must not have. Only the endings rule
/// faults it, and that is enough to make the document abnormal.
#[test]
fn check_faults_a_file_whose_only_crlf_no_other_rule_can_reach() {
    let src = utf8(b"first\r\nsecond\n");
    let c = check(src, &opts()).expect("spans convert");
    assert!(!c.is_normal());
    let faulting: Vec<&str> = c
        .rules
        .iter()
        .filter(|r| !r.is_normal())
        .map(|r| r.rule)
        .collect();
    assert_eq!(faulting, vec!["endings"]);
    assert_eq!(
        c.departures()
            .map(|(_, d)| (d.line, d.column))
            .collect::<Vec<_>>(),
        vec![(1, 6)]
    );
    assert_eq!(formatted(src).output, utf8(b"first\nsecond\n"));
}

/// **Asserted failure (f).** Deleting the blank line after front matter is the
/// clause that was measured and withdrawn: it changed 988 of 1052 corpus files
/// for a cosmetic preference. Pinned as a refusal so reinstating it is a
/// deliberate act with a red test attached.
#[test]
fn no_blank_line_after_front_matter_is_not_the_normal_form() {
    let src = utf8(b"---\nk: v\n---\n\n\n# H\n\nbody\n");
    assert_ne!(
        formatted(src).output,
        utf8(b"---\nk: v\n---\n# H\n\nbody\n")
    );
    assert_eq!(
        formatted(src).output,
        utf8(b"---\nk: v\n---\n\n# H\n\nbody\n")
    );
}
