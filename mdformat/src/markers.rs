//! List markers: an **opt-in** rewrite that unifies every bullet to `-` and
//! every ordered-list delimiter to `.`.
//!
//! Nothing here runs unless a caller asks for it, and nothing here writes a
//! file — the posture [`crate::normalize`] and [`crate::table`] take. [`unify`]
//! returns a candidate; [`Unification::accepted`] is the only accessor that
//! hands out its bytes, and it returns `None` unless both guards cleared.
//!
//! # The normal form
//!
//! - a bullet list item is introduced by `-`, never by `*` or `+`;
//! - an ordered list item's number is followed by `.`, never by `)`.
//!
//! That is the whole of it. The **ordinals are not touched** — `3.` stays `3.`
//! and a list numbered `1. 1. 1.` stays that way — and neither is a marker's
//! indentation, its trailing padding, or the content column it establishes.
//! Every edit this rule makes is a single ASCII byte replaced by another single
//! ASCII byte, so the rewrite preserves the file's length, its line count, and
//! every column in it. [`marker_violation`] is that statement as a guard.
//!
//! # This rule is preservative, and that is the point
//!
//! A census of the vault found the corpus unanimous: 10 958 of 10 958 bullet
//! items already use `-`, 2519 of 2519 ordered items already use `.`, and no
//! file mixes markers. So the expected corrective effect was **zero files**,
//! and zero was the pass condition rather than an argument that the rule is
//! idle. A formatter mostly enforces what is already true; that is what having
//! one is for.
//!
//! The census was a script, and one of that script's other counts had already
//! been found wrong, so the prediction was **re-measured against this rule**
//! rather than inherited:
//!
//! - the `corpus.sh` corpus (files the vault's ignore rules admit): **0**
//!   departures, **0** declined constructs;
//! - the same corpus with `--no-ignore`: **1** file, 5 departures — all `+`
//!   bullets in `.firecrawl/tomshardware-flash.md`, a scraped web page, and 0
//!   declined constructs anywhere.
//!
//! That one file is the argument for the rule stated as evidence rather than as
//! a forecast. It is not vault prose; it is content that arrived from outside,
//! carrying the marker its source used. Drift has real entry points — pasted
//! content, other tools, and agents writing into the vault all emit `*` bullets
//! routinely — and this rule closes them.
//!
//! The **zero declined constructs** is the key half, because it
//! says the declination path has no corpus exposure at all. Every clause of it
//! is exercised by this module's tests, `tests/markers.rs` and
//! `tests/normal_form.rs`, and nowhere else.
//!
//! # The structural hazard, and the construct this declines
//!
//! In CommonMark a change of bullet character **starts a new list**. So
//!
//! ```text
//! - a
//! + b
//! ```
//!
//! is two lists, and unifying the markers splices them into one. The same holds
//! for `1.` against `1)`. The rule is therefore a safe no-op wherever
//! neighbouring lists already agree, and structurally destructive in exactly
//! the mixed case it exists to address.
//!
//! The resolution is the per-construct declination [`crate::table::pad`] uses
//! for a ragged table: two **adjacent sibling lists** of the same kind whose
//! markers differ are both left verbatim, and both are reported. Adjacency is
//! read off the tree, so it holds inside a block quote and inside a list item
//! as well as at the top level — nested siblings merge on the same rule.
//!
//! Declining leaves the document *normal*, by the derivation
//! [`crate::format`] states: a construct the rule does not edit contributes no
//! departure. Declining is also idempotent, since the pair stays mixed and
//! stays declined on every later pass.
//!
//! # The two guards
//!
//! 1. **Re-parse structural equivalence** ([`crate::structure`]), through
//!    [`crate::structure::Structure::diff_ignoring_markers`]. Unlike the gap
//!    rule this one rewrites **content** bytes, so it cannot inherit the gap
//!    rule's argument that it only ever touches whitespace outside every span;
//!    it is in [`crate::table::pad`]'s class and needs the oracle. The
//!    exemption in the name is exactly the `markers` signature, which this
//!    rewrite is defined to change; `kinds`, `rich`, `html` and `tables` all
//!    still apply, and `kinds` is what catches a merge.
//!
//!    The adjacency declination above and this guard are not redundant. The
//!    declination is per-construct and keeps the rest of the document
//!    formattable; the guard is whole-document and catches a merge the
//!    adjacency check has no way to see. `+ + +` is the specimen: three nested
//!    single-item bullet lists, none of them adjacent to a sibling, whose
//!    unified form `- - -` is a **thematic break**. Nothing about adjacency
//!    predicts that; the `kinds` comparison refuses it.
//!
//! 2. **The substitution oracle**, [`marker_violation`]: the output has the
//!    input's length, and every byte that differs went from `*` or `+` to `-`,
//!    or from `)` to `.`. It reads the two byte strings and nothing else — not
//!    the edit list it is checking — so a splice that wrote the right byte at
//!    the wrong offset fails it.
//!
//!    It is not redundant with guard 1, and the reason is the exemption guard 1
//!    carries: markers are exactly what that oracle is blind to, so a unifier
//!    that settled on `*` instead of `-` passes it with nothing to report. This
//!    oracle states a **direction**, not a set of characters, and it is the
//!    only thing between this rule and a silently reversed normal form.
//!    `tests/markers.rs::only_the_substitution_oracle_can_see_which_marker_was_chosen`
//!    is that measurement.
//!
//!    What it cannot decide on its own is whether a changed byte was a list
//!    marker at all; a `*` turned into a `-` inside a paragraph or a code block
//!    satisfies it, and guard 1 is what refuses that. The two are complementary
//!    in both directions, which is why both are here.
//!
//! Neither guard can settle the *choice* of `-` over `*`, and no guard could:
//! every candidate marker produces the same parse and the same render, so both
//! all the oracles can do is hold the crate to whichever choice was made. That
//! choice
//! is settled by the census above, and `tests/normal_form.rs` pins it in
//! hand-written bytes.

use comrak::nodes::{AstNode, ListDelimType, ListType, NodeList, NodeValue};

use crate::span::{LineIndex, PosError};
use crate::structure::{StructureDiff, structure_of};

/// The bullet character the normal form uses.
const BULLET: u8 = b'-';
/// The ordered-list delimiter the normal form uses.
const DELIMITER: u8 = b'.';

/// The most digits CommonMark allows in an ordered list marker. A run longer
/// than this is not a list marker, so a scan that reaches it has lost its way
/// and the list is declined rather than guessed at.
const MAX_ORDINAL_DIGITS: usize = 9;

/// A list this rewrite left alone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkippedList {
    /// 1-based line the list starts on.
    pub line: usize,
    pub reason: ListSkipReason,
}

/// Why a list was left alone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ListSkipReason {
    /// A list of the same kind sits immediately beside this one with a
    /// different marker, so unifying the two would splice them into one list.
    MixedAdjacent {
        /// 1-based line the neighbouring list starts on.
        neighbour: usize,
        /// This list's marker.
        here: char,
        /// The neighbour's.
        there: char,
    },
    /// The bytes at an item's own sourcepos do not read as the marker the
    /// parse says is there.
    UnreadableMarker { line: usize },
}

impl std::fmt::Display for ListSkipReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ListSkipReason::MixedAdjacent {
                neighbour,
                here,
                there,
            } => write!(
                f,
                "the list at line {neighbour} sits beside it with marker {there:?} against {here:?}, \
                 and unifying the two would merge them into one list"
            ),
            ListSkipReason::UnreadableMarker { line } => write!(
                f,
                "the item at line {line} does not begin with the marker the parse reports"
            ),
        }
    }
}

/// One marker byte the rewrite changes, for reporting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkerChange {
    /// 1-based line.
    pub line: usize,
    /// 1-based byte column of the marker itself.
    pub column: usize,
    pub old: char,
    pub new: char,
    /// Whether this is an ordered list's delimiter rather than a bullet.
    pub ordered: bool,
}

impl MarkerChange {
    /// What the changed byte is called, for a one-line report.
    pub fn what(&self) -> &'static str {
        if self.ordered {
            "the ordered-list delimiter"
        } else {
            "the list bullet"
        }
    }
}

/// How the substitution oracle was violated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MarkerViolation {
    /// The rewrite changed the file's length, which a marker substitution
    /// cannot do.
    Length { before: usize, after: usize },
    /// A byte changed that is not one of the three substitutions this rewrite
    /// is defined to make.
    Substitution {
        line: usize,
        column: usize,
        before: char,
        after: char,
    },
}

impl std::fmt::Display for MarkerViolation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MarkerViolation::Length { before, after } => write!(
                f,
                "the rewrite changed the byte length from {before} to {after}"
            ),
            MarkerViolation::Substitution {
                line,
                column,
                before,
                after,
            } => write!(
                f,
                "line {line}:{column}: {before:?} became {after:?}, which is not a marker substitution"
            ),
        }
    }
}

/// A candidate unification and everything needed to decide whether to take it.
/// Construct with [`unify`]; read the bytes with [`Unification::accepted`].
///
/// There is no `input_partition` here, unlike [`crate::table::Padding`]. The
/// partition is what makes a *gap* definable, and it is recorded by `pad`
/// because a table rewrite is defined over whole-line ranges. This rewrite is
/// defined over single byte offsets taken from item sourcepos, so the partition
/// is neither a precondition nor a coordinate system it uses.
#[derive(Debug, Clone)]
pub struct Unification {
    /// The candidate bytes. Present even when refused, so a caller can report
    /// what would have happened.
    pub output: String,
    /// Lists the parse found, nested ones included.
    pub lists_seen: usize,
    /// Lists at least one of whose markers changed.
    pub lists_changed: usize,
    /// Lists left byte-identical because this rewrite declines to touch them.
    pub skipped: Vec<SkippedList>,
    /// Marker bytes the rewrite changes, in source order.
    pub changes: Vec<MarkerChange>,
    /// `None` when the re-parse is equivalent on every signature but
    /// `markers`; otherwise why not.
    pub structure: Option<StructureDiff>,
    /// `None` when the substitution oracle passed; otherwise the first
    /// violation.
    pub violation: Option<MarkerViolation>,
}

impl Unification {
    /// Whether the candidate differs from the input at all.
    pub fn changed(&self) -> bool {
        !self.changes.is_empty()
    }

    /// The unified bytes, or `None` when they must not be used. This is the
    /// only accessor that clears the guards, so a caller cannot take the bytes
    /// without them.
    pub fn accepted(&self) -> Option<&str> {
        (self.structure.is_none() && self.violation.is_none()).then_some(&*self.output)
    }
}

/// The marker this rewrite would give a list of this kind.
fn target(list: &NodeList) -> u8 {
    match list.list_type {
        ListType::Bullet => BULLET,
        ListType::Ordered => DELIMITER,
    }
}

/// The marker a list carries now, as comrak reports it.
fn current(list: &NodeList) -> u8 {
    match list.list_type {
        ListType::Bullet => list.bullet_char,
        ListType::Ordered => match list.delimiter {
            ListDelimType::Period => b'.',
            ListDelimType::Paren => b')',
        },
    }
}

/// The `NodeList` of a list node, or `None` for every other node.
fn list_of<'a>(node: &'a AstNode<'a>) -> Option<NodeList> {
    match &node.data.borrow().value {
        NodeValue::List(list) => Some(*list),
        _ => None,
    }
}

/// Whether a sibling list sits immediately beside this one and would merge with
/// it once both markers are unified.
///
/// Both members of a mixed pair see each other — the scan looks left and right —
/// so both are declined and both are reported, which is what keeps the
/// declination symmetric. Two neighbouring lists of the same kind whose markers
/// already agree are left to the rewrite: it is a no-op on them, so it cannot
/// be what merges them.
fn mixed_neighbour<'a>(node: &'a AstNode<'a>, list: &NodeList) -> Option<ListSkipReason> {
    let here = current(list);
    for neighbour in [node.previous_sibling(), node.next_sibling()]
        .into_iter()
        .flatten()
    {
        let Some(other) = list_of(neighbour) else {
            continue;
        };
        if other.list_type != list.list_type {
            // A bullet list beside an ordered one cannot merge whatever their
            // markers become.
            continue;
        }
        let there = current(&other);
        if there == here {
            continue;
        }
        return Some(ListSkipReason::MixedAdjacent {
            neighbour: neighbour.data.borrow().sourcepos.start.line,
            here: here as char,
            there: there as char,
        });
    }
    None
}

/// One marker byte to replace.
#[derive(Debug, Clone, Copy)]
struct Edit {
    offset: usize,
    line: usize,
    column: usize,
    old: u8,
    new: u8,
    ordered: bool,
}

/// Why planning one list stopped.
enum PlanStop {
    /// The list is declined; the document is not.
    Skip(ListSkipReason),
    /// A sourcepos that does not name a byte range, which is a whole-document
    /// failure exactly as it is in [`crate::partition`].
    Pos(PosError),
}

/// Byte offset of one list item's marker character, or `None` when the bytes
/// there do not read as the marker comrak reported.
///
/// Read from the **source** rather than trusted from the tree, because the
/// offset is what the rewrite writes to: an item sourcepos that pointed
/// somewhere else would otherwise put a `-` into arbitrary content.
fn marker_offset(source: &str, start: usize, list: &NodeList) -> Option<usize> {
    let bytes = source.as_bytes();
    match list.list_type {
        ListType::Bullet => {
            let b = *bytes.get(start)?;
            (b == list.bullet_char && matches!(b, b'*' | b'+' | b'-')).then_some(start)
        }
        ListType::Ordered => {
            let mut i = start;
            while i < bytes.len() && bytes[i].is_ascii_digit() && i - start < MAX_ORDINAL_DIGITS {
                i += 1;
            }
            if i == start {
                return None;
            }
            (*bytes.get(i)? == current(list)).then_some(i)
        }
    }
}

/// Every marker byte one list would have replaced, or why it is declined.
fn plan_list<'a>(
    source: &str,
    idx: &LineIndex,
    node: &'a AstNode<'a>,
    list: &NodeList,
) -> Result<Vec<Edit>, PlanStop> {
    let new = target(list);
    let ordered = list.list_type == ListType::Ordered;
    let mut edits = Vec::new();
    for item in node.children() {
        let (sourcepos, is_item) = {
            let data = item.data.borrow();
            (
                data.sourcepos,
                matches!(data.value, NodeValue::Item(_) | NodeValue::TaskItem(_)),
            )
        };
        let line = sourcepos.start.line;
        if !is_item {
            return Err(PlanStop::Skip(ListSkipReason::UnreadableMarker { line }));
        }
        let (start, _) = idx
            .byte_span("listItem", sourcepos)
            .map_err(PlanStop::Pos)?;
        let Some(offset) = marker_offset(source, start, list) else {
            return Err(PlanStop::Skip(ListSkipReason::UnreadableMarker { line }));
        };
        let old = source.as_bytes()[offset];
        if old != new {
            let (line, column) = idx.position_of(offset);
            edits.push(Edit {
                offset,
                line,
                column,
                old,
                new,
                ordered,
            });
        }
    }
    Ok(edits)
}

/// The substitution oracle: `output` is `source` with nothing changed but
/// marker bytes, each changed to the marker this rewrite is defined to write.
///
/// Reads only the two byte strings. It is deliberately blind to the edit list
/// that produced `output`, so it is a measurement of the result rather than a
/// restatement of the plan.
pub fn marker_violation(source: &str, output: &str) -> Option<MarkerViolation> {
    if source.len() != output.len() {
        return Some(MarkerViolation::Length {
            before: source.len(),
            after: output.len(),
        });
    }
    let idx = LineIndex::new(source);
    for (i, (&before, &after)) in source
        .as_bytes()
        .iter()
        .zip(output.as_bytes().iter())
        .enumerate()
    {
        if before == after {
            continue;
        }
        // The three substitutions, exhaustively. `-` and `.` are already the
        // normal form, so no legal change starts from either.
        if matches!(
            (before, after),
            (b'*', BULLET) | (b'+', BULLET) | (b')', DELIMITER)
        ) {
            continue;
        }
        let (line, column) = idx.position_of(i);
        return Some(MarkerViolation::Substitution {
            line,
            column,
            before: before as char,
            after: after as char,
        });
    }
    None
}

/// Compute the marker-unified form of `source` and check it.
///
/// Writes nothing and decides nothing: the result carries the candidate bytes,
/// the lists it declined, the markers it would change, and both guards'
/// verdicts. [`Unification::accepted`] is the only way to get bytes that
/// cleared them.
///
/// `Err` carries every sourcepos that does not name a byte range in `source`,
/// exactly as [`crate::partition`] does.
pub fn unify(source: &str, opts: &mdstruct::Options) -> Result<Unification, Vec<PosError>> {
    let arena = comrak::Arena::new();
    let idx = LineIndex::new(source);

    type Planned = (Vec<Edit>, Vec<SkippedList>, usize, usize);
    let planned: Result<Planned, Vec<PosError>> = crate::parse_with(&arena, source, opts, |root| {
        let mut errors = Vec::new();
        let mut edits: Vec<Edit> = Vec::new();
        let mut skipped = Vec::new();
        let mut lists_seen = 0usize;
        let mut lists_changed = 0usize;
        for node in root.descendants() {
            let Some(list) = list_of(node) else {
                continue;
            };
            lists_seen += 1;
            let line = node.data.borrow().sourcepos.start.line;
            if let Some(reason) = mixed_neighbour(node, &list) {
                skipped.push(SkippedList { line, reason });
                continue;
            }
            match plan_list(source, &idx, node, &list) {
                Ok(list_edits) => {
                    if !list_edits.is_empty() {
                        lists_changed += 1;
                    }
                    edits.extend(list_edits);
                }
                Err(PlanStop::Skip(reason)) => skipped.push(SkippedList { line, reason }),
                Err(PlanStop::Pos(e)) => errors.push(e),
            }
        }
        if errors.is_empty() {
            Ok((edits, skipped, lists_seen, lists_changed))
        } else {
            Err(errors)
        }
    });
    let (mut edits, skipped, lists_seen, lists_changed) = planned?;

    edits.sort_by_key(|e| e.offset);
    // Byte replacement rather than a splice: every edit is one ASCII byte for
    // another at an offset the source was read at, so the buffer stays valid
    // UTF-8 and the file's length, line count and columns are preserved by
    // construction. `marker_violation` holds that claim as a guard rather than
    // leaving it to this comment.
    let mut bytes = source.as_bytes().to_vec();
    let mut changes = Vec::with_capacity(edits.len());
    for e in &edits {
        debug_assert_eq!(bytes[e.offset], e.old, "marker edits must not overlap");
        bytes[e.offset] = e.new;
        changes.push(MarkerChange {
            line: e.line,
            column: e.column,
            old: e.old as char,
            new: e.new as char,
            ordered: e.ordered,
        });
    }
    let output =
        String::from_utf8(bytes).expect("replacing one ASCII byte with another cannot break UTF-8");

    let structure = structure_of(source, opts).diff_ignoring_markers(&structure_of(&output, opts));
    let violation = marker_violation(source, &output);

    Ok(Unification {
        output,
        lists_seen,
        lists_changed,
        skipped,
        changes,
        structure,
        violation,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(source: &str) -> Unification {
        unify(source, &mdstruct::Options::default()).expect("spans convert")
    }

    #[test]
    fn star_and_plus_bullets_become_dashes() {
        assert_eq!(u("* a\n* b\n").accepted(), Some("- a\n- b\n"));
        assert_eq!(u("+ a\n+ b\n").accepted(), Some("- a\n- b\n"));
    }

    #[test]
    fn a_paren_delimiter_becomes_a_period() {
        assert_eq!(u("1) a\n2) b\n").accepted(), Some("1. a\n2. b\n"));
    }

    #[test]
    fn the_ordinals_are_left_alone() {
        // Scope is the marker character. Renumbering `3.` and `7.` to `1.` and
        // `2.` is a different rewrite with a different argument behind it, and
        // this rule must not start it by accident.
        assert_eq!(
            u("3) three\n7) seven\n").accepted(),
            Some("3. three\n7. seven\n")
        );
        assert_eq!(
            u("1. a\n1. b\n1. c\n").accepted(),
            Some("1. a\n1. b\n1. c\n")
        );
    }

    #[test]
    fn indentation_and_nesting_survive() {
        // Every edit is one byte for one byte, so the content column a marker
        // establishes cannot move.
        let n = u("* outer\n  * inner\n    * deeper\n* tail\n");
        assert_eq!(
            n.accepted(),
            Some("- outer\n  - inner\n    - deeper\n- tail\n")
        );
        assert_eq!(
            n.output.len(),
            "* outer\n  * inner\n    * deeper\n* tail\n".len()
        );
    }

    #[test]
    fn a_task_items_checkbox_is_untouched() {
        assert_eq!(
            u("* [ ] todo\n* [x] done\n").accepted(),
            Some("- [ ] todo\n- [x] done\n")
        );
    }

    #[test]
    fn a_marker_character_inside_content_is_not_a_marker() {
        // The rewrite is addressed by item sourcepos, so a `*` opening emphasis
        // or sitting in a code span is not a candidate. Nothing here changes.
        let n = u("para with *emphasis* and a + sign\n\n    * indented code\n");
        assert!(!n.changed());
        assert_eq!(
            n.accepted(),
            Some("para with *emphasis* and a + sign\n\n    * indented code\n")
        );
    }

    #[test]
    fn two_adjacent_bullet_lists_with_different_markers_are_declined() {
        // Both members of the pair are declined, because unifying either one
        // alone would still leave the document short of the normal form and
        // unifying both would merge them.
        let n = u("* a\n\n+ b\n");
        assert!(!n.changed());
        assert_eq!(n.skipped.len(), 2);
        assert_eq!(n.lists_seen, 2);
        assert_eq!(n.lists_changed, 0);
        assert!(matches!(
            n.skipped[0].reason,
            ListSkipReason::MixedAdjacent { .. }
        ));
    }

    #[test]
    fn two_adjacent_ordered_lists_with_different_delimiters_are_declined() {
        let n = u("1. a\n\n1) b\n");
        assert!(!n.changed());
        assert_eq!(n.skipped.len(), 2);
    }

    #[test]
    fn a_bullet_list_beside_an_ordered_list_is_not_declined() {
        // The causal control: the single differing factor against the two
        // tests above is the list kind, and lists of different kinds cannot
        // merge whatever their markers become.
        let n = u("* a\n\n1) b\n");
        assert!(n.skipped.is_empty());
        assert_eq!(n.accepted(), Some("- a\n\n1. b\n"));
    }

    #[test]
    fn a_paragraph_between_two_mixed_lists_removes_the_adjacency() {
        // The other causal control: the same two lists, no longer siblings in
        // sequence, and both are unified.
        let n = u("* a\n\npara\n\n+ b\n");
        assert!(n.skipped.is_empty());
        assert_eq!(n.accepted(), Some("- a\n\npara\n\n- b\n"));
    }

    #[test]
    fn adjacency_is_read_off_the_tree_so_it_holds_inside_a_container() {
        // Inside a block quote.
        let quoted = u("> - q\n> + r\n");
        assert!(!quoted.changed());
        assert_eq!(quoted.skipped.len(), 2);

        // And between two sublists of one item, which is the shape a top-level
        // scan would miss entirely.
        let nested = u("- a\n  - b\n  * c\n");
        assert!(!nested.changed());
        assert_eq!(nested.skipped.len(), 2);
    }

    #[test]
    fn a_declined_pair_does_not_stop_an_unrelated_list_from_being_unified() {
        // The declination is per-construct, so the rest of the document is
        // still formatted. `* x` is separated from the pair by a paragraph.
        let n = u("* x\n\npara\n\n* a\n\n+ b\n");
        assert_eq!(n.skipped.len(), 2);
        assert_eq!(n.accepted(), Some("- x\n\npara\n\n* a\n\n+ b\n"));
    }

    #[test]
    fn the_thematic_break_hazard_is_refused_by_the_structure_guard() {
        // `+ + +` is three nested one-item bullet lists, none of them beside a
        // sibling, so the adjacency check has nothing to say. Its unified form
        // `- - -` is a thematic break — a different document — and the `kinds`
        // comparison is what refuses it.
        let n = u("+ + +\n");
        assert!(n.changed(), "the rewrite must want to make this change");
        assert_eq!(n.output, "- - -\n");
        let diff = n.structure.as_ref().expect("the guard must refuse this");
        assert!(!diff.kinds_same, "{diff}");
        assert_eq!(n.accepted(), None);
    }

    #[test]
    fn the_substitution_oracle_refuses_a_byte_that_is_not_a_marker_change() {
        // Read against the two byte strings, so it does not need a rewrite to
        // have gone wrong to be exercised.
        assert_eq!(marker_violation("- a\n", "- a\n"), None);
        assert_eq!(marker_violation("* a\n", "- a\n"), None);
        assert_eq!(marker_violation("1) a\n", "1. a\n"), None);
        assert_eq!(
            marker_violation("* a\n", "* b\n"),
            Some(MarkerViolation::Substitution {
                line: 1,
                column: 3,
                before: 'a',
                after: 'b',
            })
        );
        // A dash turned back into a star is not a legal substitution either:
        // the oracle states a direction, not a set of characters.
        assert!(matches!(
            marker_violation("- a\n", "* a\n"),
            Some(MarkerViolation::Substitution { .. })
        ));
        assert_eq!(
            marker_violation("- a\n", "- ab\n"),
            Some(MarkerViolation::Length {
                before: 4,
                after: 5
            })
        );
    }

    #[test]
    fn an_already_unified_document_is_unchanged_and_reports_nothing() {
        let n = u("- a\n- b\n\n1. one\n2. two\n");
        assert!(!n.changed());
        assert!(n.skipped.is_empty());
        assert_eq!(n.accepted(), Some("- a\n- b\n\n1. one\n2. two\n"));
    }

    #[test]
    fn a_document_with_no_list_is_untouched() {
        let n = u("# H\n\npara\n");
        assert_eq!(n.lists_seen, 0);
        assert!(!n.changed());
    }
}
