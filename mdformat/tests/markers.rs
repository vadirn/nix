//! The list-marker rule's guards, held open against deliberately wrong
//! unifiers.
//!
//! `src/markers.rs` asserts what the real unifier produces. That is half a
//! contract: a guard that never fails passes those tests too, and this crate
//! has shipped three guards that turned out to pass everything they were
//! supposed to catch — reassembly equality, the unary partition oracle, and a
//! proposed `\r`-blind oracle. So the marker rule's two guards are exercised
//! here from the failure side, each against a unifier someone could plausibly
//! write.
//!
//! # The one that matters
//!
//! In CommonMark a change of bullet character **starts a new list**, so
//!
//! ```text
//! - a
//! + b
//! ```
//!
//! is two lists and the unified form is one. The rule prevents that by
//! declining the pair, which means the merged bytes never reach the oracle in
//! normal operation — and an oracle that is never asked is an oracle nobody has
//! checked. [`the_structure_oracle_rejects_the_merge_the_declination_prevents`]
//! asks it directly: it hands the oracle the exact bytes a unifier without the
//! declination would emit, and asserts the refusal. The rule is therefore
//! guarded twice over, and both are measured rather than assumed.
//!
//! # What the bytes cannot say
//!
//! The rule's other two verdicts — *this construct is declined* and *this
//! document is already normal* — produce the same bytes as each other and as
//! doing nothing at all. Three of this file's tests therefore assert on the
//! **report** (`Unification::skipped`, and `check`'s `exempt`, `departures` and
//! `declined`) rather than on `correct`'s output, and each states in its own
//! docs the mutation that was run to show it can go red.
//!
//! Fixtures are embedded byte literals, per `negative_controls.rs`.

use mdformat::{
    ListSkipReason, MarkerViolation, RuleRun, Structure, check, marker_violation, structure_of,
    unify,
};

fn opts() -> mdstruct::Options {
    mdstruct::Options::default()
}

fn utf8(bytes: &[u8]) -> &str {
    std::str::from_utf8(bytes).expect("fixtures are UTF-8")
}

fn structure(source: &str) -> Structure {
    structure_of(source, &opts())
}

/// The marker rule's own row of a [`check`] report — its verdict on a document,
/// readable apart from the other three rules.
fn markers_row(source: &str) -> RuleRun {
    let c = check(source, &opts()).expect("spans convert");
    c.rules
        .iter()
        .find(|r| r.rule == "markers")
        .expect("the marker rule is in RULES")
        .clone()
}

/// The real unifier's accepted output.
fn correct(source: &str) -> String {
    unify(source, &opts())
        .expect("spans convert")
        .accepted()
        .expect("the real unifier must clear its own guards")
        .to_string()
}

/// **The report a declined pair must produce**, asserted where a byte
/// comparison is blind.
///
/// A mixed adjacent pair comes back verbatim. So does a document the rule found
/// nothing to do in, and so does one whose merge the whole-document oracle
/// caught after the fact — three different events, one set of bytes. The
/// difference is entirely in the report, and it is read here three ways:
///
/// - `skipped` names **both** members, each pointing at the other, which is
///   what makes the declination symmetric rather than a coin toss over which
///   list keeps its marker;
/// - `structure` and `violation` are empty, which says the pair was left alone
///   *by the rule* and not rescued by its guard — the one distinction that
///   separates a principled refusal from a merge that got caught;
/// - the same two constructs survive into `check`'s `exempt`, so the rule
///   adapter reports them rather than swallowing them.
///
/// Measured, not argued. Recording the exemption for top-level pairs only —
/// which leaves every byte in the crate where it was — turns this test and one
/// `src/markers.rs` unit test red and nothing else; 181 of 183 still pass.
/// Making the exemption name its own list instead of its neighbour's turns
/// **only** this test red, which is the assertion no counting test can make.
fn assert_the_pair_is_reported_exempt(source: &str) {
    let u = unify(source, &opts()).expect("spans convert");
    assert!(
        u.structure.is_none() && u.violation.is_none(),
        "{source:?}: a whole-document guard fired, so the per-construct \
         declination is not what left this document alone: {:?} {:?}",
        u.structure.as_ref().map(|d| d.to_string()),
        u.violation.as_ref().map(|v| v.to_string()),
    );
    let pair: Vec<(usize, char, char, usize)> = u
        .skipped
        .iter()
        .map(|s| match s.reason {
            ListSkipReason::MixedAdjacent {
                neighbour,
                here,
                there,
            } => (s.line, here, there, neighbour),
            ref other => panic!(
                "{source:?}: the list at line {} was declined for the wrong reason: {other}",
                s.line
            ),
        })
        .collect();
    assert_eq!(
        pair.len(),
        2,
        "{source:?}: both members of the pair must be reported, got {pair:?}"
    );
    let (a, b) = (pair[0], pair[1]);
    assert_eq!(
        (a.3, b.3),
        (b.0, a.0),
        "{source:?}: the two exemptions must name each other's line, got {pair:?}"
    );
    assert_eq!(
        (a.1, a.2),
        (b.2, b.1),
        "{source:?}: each exemption must read the pair's markers from its own \
         side, got {pair:?}"
    );
    assert_eq!(
        u.accepted(),
        Some(source),
        "the real rule must leave {source:?} verbatim"
    );

    let r = markers_row(source);
    assert!(
        r.is_normal(),
        "{source:?}: a document whose only fault is exempt is in normal form"
    );
    assert_eq!(
        r.departures(),
        &[],
        "{source:?}: a construct the rule declined produces no departure"
    );
    assert!(
        r.declined.is_none(),
        "{source:?}: the rule declined the whole document: {:?}",
        r.declined
    );
    assert_eq!(
        r.exempt.len(),
        2,
        "{source:?}: both members must reach the report, got {:?}",
        r.exempt
    );
    for e in &r.exempt {
        assert!(
            e.why.contains("merge them into one list"),
            "{source:?}: the exemption must state why: {e:?}"
        );
    }
}

// ---------------------------------------------------------------------------
// Guard 1: re-parse structural equivalence, less the marker signature
// ---------------------------------------------------------------------------

/// **The merge, put past the oracle by hand.**
///
/// This is the rewrite the per-construct declination exists to prevent, so it
/// is the one shape the oracle is never handed in normal operation. Written out
/// here as the bytes a unifier *without* the declination would emit, on both
/// the bullet and the ordered side, in both nesting positions the rule has to
/// cover.
///
/// The assertion is on `kinds`: two lists become one, so the pre-order walk
/// emits one fewer `list` entry. Naming the failing signature rather than only
/// its `Option` is what keeps this from passing for an unrelated reason.
#[test]
fn the_structure_oracle_rejects_the_merge_the_declination_prevents() {
    // (input, what a unifier without the declination would emit)
    let merges: &[(&[u8], &[u8])] = &[
        // Two top-level bullet lists, tight.
        (b"- a\n+ b\n", b"- a\n- b\n"),
        // The same pair loose, which is the shape the fixture suite carries.
        (b"* alpha\n\n+ beta\n", b"- alpha\n\n- beta\n"),
        // Ordered, where the delimiter rather than the bullet decides it.
        (b"1. one\n\n1) two\n", b"1. one\n\n1. two\n"),
        // Two sublists of one item: a check that looked only at top-level
        // blocks would miss this entirely.
        (b"- a\n  - b\n  * c\n", b"- a\n  - b\n  - c\n"),
        // And inside a block quote.
        (b"> - q\n> + r\n", b"> - q\n> - r\n"),
    ];
    for (input, merged) in merges {
        let (input, merged) = (utf8(input), utf8(merged));
        let diff = structure(input)
            .diff_ignoring_markers(&structure(merged))
            .unwrap_or_else(|| panic!("the oracle passed a merge of {input:?} into {merged:?}"));
        assert!(
            !diff.kinds_same,
            "the merge of {input:?} must show as a kinds difference, got {diff}"
        );
        // And the causal control: the same input left alone by the rule is
        // accepted, so the rejection above is about the merge and not about the
        // specimen. Read from the report rather than from the bytes — the two
        // specimens that live only here, the nested sublists and the pair
        // inside a block quote, are byte-indistinguishable from a document the
        // rule had nothing to say about.
        assert_the_pair_is_reported_exempt(input);
    }
}

/// The counterpart, and the reason the oracle needed the marker signature moved
/// out of `rich` rather than dropped: a marker change that merges **nothing**
/// must pass. Without this the test above would be satisfied by an oracle that
/// rejects every marker rewrite, which is an oracle that turns the rule off.
#[test]
fn the_same_oracle_accepts_a_marker_change_that_merges_nothing() {
    for src in [
        &b"* a\n* b\n"[..],
        &b"1) a\n2) b\n"[..],
        &b"* outer\n  * inner\n* tail\n"[..],
        &b"* [ ] todo\n* [x] done\n"[..],
        &b"> * quoted\n"[..],
    ] {
        let src = utf8(src);
        let out = correct(src);
        assert_ne!(out, src, "{src:?} must actually be rewritten");
        assert_eq!(
            structure(src).diff_ignoring_markers(&structure(&out)),
            None,
            "the oracle refused a rewrite that merges nothing: {src:?}"
        );
    }
}

/// The exemption is exactly one signature wide. `diff` — what every other rule
/// uses — still fails on the same pair, so moving `bullet_char` and `delimiter`
/// out of `rich` gave nothing away crate-wide.
#[test]
fn the_unexempt_oracle_still_sees_the_marker_change() {
    let src = utf8(b"* a\n* b\n");
    let out = correct(src);
    let diff = structure(src)
        .diff(&structure(&out))
        .expect("the full oracle must see a marker change");
    assert!(!diff.markers_same, "{diff}");
    assert!(diff.kinds_same && diff.rich_same && diff.html_same && diff.tables_same);
}

/// A unifier that rewrote a `*` wherever it found one — the naive
/// search-and-replace — changes text, not markers. `kinds` cannot see it and
/// the substitution oracle cannot either, since `*` → `-` is a legal
/// substitution byte for byte. `html` is what refuses it.
#[test]
fn a_unifier_that_rewrites_a_star_in_running_text_is_rejected() {
    let src = utf8(b"* item\n\npara with *emphasis* in it\n");
    let naive = utf8(b"- item\n\npara with -emphasis- in it\n");
    assert_eq!(
        marker_violation(src, naive),
        None,
        "the substitution oracle cannot see this one, which is why guard 1 exists"
    );
    let diff = structure(src)
        .diff_ignoring_markers(&structure(naive))
        .expect("the oracle was expected to reject this unifier");
    assert!(!diff.html_same, "{diff}");
    // The causal control: the real rule changes the bullet and leaves the
    // emphasis alone.
    assert_eq!(
        correct(src),
        utf8(b"- item\n\npara with *emphasis* in it\n")
    );
}

/// The same defect one block over: a `*` inside a code block is content, and a
/// unifier that reached into one changes a code-block literal. `rich` refuses
/// it — the signature that deliberately does **not** trim a code literal.
#[test]
fn a_unifier_that_reaches_into_a_code_block_is_rejected() {
    let src = utf8(b"* item\n\n```\n* not a list\n```\n");
    let naive = utf8(b"- item\n\n```\n- not a list\n```\n");
    assert_eq!(marker_violation(src, naive), None);
    let diff = structure(src)
        .diff_ignoring_markers(&structure(naive))
        .expect("the oracle was expected to reject this unifier");
    assert!(!diff.rich_same, "{diff}");
    assert_eq!(correct(src), utf8(b"- item\n\n```\n* not a list\n```\n"));
}

// ---------------------------------------------------------------------------
// Guard 2: the substitution oracle
// ---------------------------------------------------------------------------

/// **What guard 2 alone can see**, and the reason the rule needs it.
///
/// Guard 1 is exempt from the marker signature — that is what lets the rule run
/// at all — so it is blind to *which* marker the rewrite chose. A unifier that
/// settled on `*` instead of `-`, or that turned a `+` into a `*`, passes guard
/// 1 with nothing to report. The substitution oracle states a **direction**,
/// not a set of characters, and it is the only thing between this rule and a
/// silently reversed normal form.
///
/// This is the causal control for the guard's existence: one measurement where
/// guard 1 says nothing and guard 2 says everything.
#[test]
fn only_the_substitution_oracle_can_see_which_marker_was_chosen() {
    // `-` is the normal form, so nothing may leave it.
    let src = utf8(b"- a\n- b\n");
    let starred = utf8(b"* a\n* b\n");
    assert_eq!(
        structure(src).diff_ignoring_markers(&structure(starred)),
        None,
        "guard 1 is exempt from exactly this, which is why guard 2 exists"
    );
    assert_eq!(
        marker_violation(src, starred),
        Some(MarkerViolation::Substitution {
            line: 1,
            column: 1,
            before: '-',
            after: '*',
        })
    );

    // And the same for a unifier that moved between the two wrong bullets.
    let plus = utf8(b"+ a\n");
    let star = utf8(b"* a\n");
    assert_eq!(
        structure(plus).diff_ignoring_markers(&structure(star)),
        None
    );
    assert!(matches!(
        marker_violation(plus, star),
        Some(MarkerViolation::Substitution {
            before: '+',
            after: '*',
            ..
        })
    ));
    assert_eq!(correct(plus), utf8(b"- a\n"));
}

/// A unifier that renumbered while it was in there. **Both** guards catch this,
/// which is worth pinning rather than assuming either way: comrak stores an
/// ordered item's ordinal as its own `start`, so a renumbering shows up in
/// `rich` as well as in the changed digit. Asserted on both sides so that a
/// future normalization of `start` — the kind of quiet widening
/// `src/structure.rs` warns about — cannot leave this defect uncovered.
#[test]
fn a_unifier_that_also_renumbers_is_rejected_by_both_guards() {
    let src = utf8(b"1) a\n1) b\n");
    let renumbering = utf8(b"1. a\n2. b\n");
    let diff = structure(src)
        .diff_ignoring_markers(&structure(renumbering))
        .expect("guard 1 must reject a renumbering");
    assert!(!diff.rich_same, "{diff}");
    assert_eq!(
        marker_violation(src, renumbering),
        Some(MarkerViolation::Substitution {
            line: 2,
            column: 1,
            before: '1',
            after: '2',
        })
    );
    assert_eq!(correct(src), utf8(b"1. a\n1. b\n"));
}

/// A unifier that reindented while it was in there, likewise caught twice: the
/// nested item's `marker_offset` moves, and the file's length changes. The
/// length check is the cheaper and the more legible of the two, and it is what
/// makes "every edit is one byte for one byte" a guard rather than a comment.
#[test]
fn a_unifier_that_also_reindents_is_rejected_by_both_guards() {
    let src = utf8(b"* outer\n  * inner\n");
    let reindented = utf8(b"- outer\n    - inner\n");
    let diff = structure(src)
        .diff_ignoring_markers(&structure(reindented))
        .expect("guard 1 must reject a reindent");
    assert!(!diff.rich_same, "{diff}");
    assert_eq!(
        marker_violation(src, reindented),
        Some(MarkerViolation::Length {
            before: 18,
            after: 20
        })
    );
    assert_eq!(correct(src), utf8(b"- outer\n  - inner\n"));
}

// ---------------------------------------------------------------------------
// The rule itself
// ---------------------------------------------------------------------------

/// One pass reaches the fixpoint, on ill-formed and declined inputs alike.
#[test]
fn unification_is_idempotent() {
    for src in [
        &b"* a\n+ b\n"[..],
        &b"* outer\n  + inner\n\n1) one\n"[..],
        &b"* alpha\n\n+ beta\n"[..],
        &b"+ + +\n"[..],
        &b"- a\n- b\n"[..],
        &b""[..],
    ] {
        let src = utf8(src);
        let once = unify(src, &opts()).expect("spans convert");
        let first = once.accepted().unwrap_or(src).to_string();
        let twice = unify(&first, &opts()).expect("spans convert");
        assert_eq!(
            twice.accepted().unwrap_or(&first),
            first,
            "the second pass changed the first's output for {src:?}"
        );
    }
}

/// **The fixpoint clause, stated on the report.** A document already written in
/// the normal form's markers is one this rule reports normal: nothing rewritten,
/// nothing to rewrite, and — the part only the report carries — nothing
/// *exempt* either.
///
/// That last clause is what makes this more than a byte comparison. `- a\n- b\n`
/// coming back unchanged is consistent with two different rules: one that read
/// the markers and found them already right, and one that declined the list and
/// never looked. The suite had a single already-normal marker specimen before
/// this, in `normal_form.rs`, and it separates those two readings for one
/// document out of the whole rule.
///
/// The specimens cover every position the rule reaches: top level, nested,
/// ordered, task items, inside a block quote, and a bullet list beside an
/// ordered one — the pair that *cannot* merge whatever their markers are, and so
/// must be reported normal rather than exempt.
///
/// Measured: a `plan_list` that returns a skip when it finds nothing to change —
/// "no edits, so leave it alone" — moves no byte anywhere in the crate and
/// turns this test red, along with two unit tests and the declination test
/// above. Not one byte fixture notices, which is the point.
#[test]
fn an_already_normal_document_is_reported_normal_by_the_rule() {
    for src in [
        &b"- a\n- b\n"[..],
        &b"1. one\n2. two\n"[..],
        &b"- outer\n  - inner\n  - sibling\n"[..],
        &b"- [x] done\n- [ ] todo\n"[..],
        &b"> - q\n> - r\n"[..],
        &b"- bullet\n\n1. ordered\n"[..],
        &b"- a\n\n1. one\n   - nested\n"[..],
    ] {
        let src = utf8(src);
        let u = unify(src, &opts()).expect("spans convert");
        assert!(
            !u.changed(),
            "{src:?}: the rule claims a marker to change: {:?}",
            u.changes
        );
        assert_eq!(u.changes, vec![], "{src:?}");
        assert_eq!(
            u.skipped,
            vec![],
            "{src:?}: an already-normal list must be found normal, not declined"
        );
        assert_eq!(u.accepted(), Some(src), "{src:?}");

        let r = markers_row(src);
        assert!(r.is_normal(), "{src:?}: the rule calls it abnormal");
        assert_eq!(
            r.departures(),
            &[],
            "{src:?}: a departure was reported where the markers are already \
             the normal form's"
        );
        assert!(r.declined.is_none(), "{src:?}: {:?}", r.declined);
        assert_eq!(
            r.exempt,
            vec![],
            "{src:?}: nothing here is declined, so nothing here is exempt"
        );
        assert_eq!(r.yielded(), src, "{src:?}");
        assert_eq!(r.accepted(), Some(src), "{src:?}");
    }
}

/// A declined pair does not cost the rest of the document its formatting, which
/// is the whole point of declining per construct rather than per document.
#[test]
fn a_declined_pair_leaves_the_rest_of_the_document_formattable() {
    let src = utf8(b"* alone\n\npara\n\n* mixed\n\n+ pair\n");
    let u = unify(src, &opts()).expect("spans convert");
    assert_eq!(u.skipped.len(), 2, "both members of the pair are exempt");
    assert_eq!(
        u.accepted(),
        Some(utf8(b"- alone\n\npara\n\n* mixed\n\n+ pair\n"))
    );
}

/// A realistic document, formatted whole: the rule reaches nested items, task
/// items and ordered lists in one pass, and touches nothing else.
#[test]
fn a_realistic_document_is_unified_in_one_pass() {
    let src = utf8(
        b"# Title\n\n\
          Intro with *emphasis*.\n\n\
          + first\n\
          + second\n\
          \x20 * nested\n\
          + [x] done\n\n\
          1) step one\n\
          2) step two\n",
    );
    assert_eq!(
        correct(src),
        utf8(
            b"# Title\n\n\
              Intro with *emphasis*.\n\n\
              - first\n\
              - second\n\
              \x20 - nested\n\
              - [x] done\n\n\
              1. step one\n\
              2. step two\n",
        )
    );
}
