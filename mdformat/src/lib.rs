//! `mdformat` — comrak's parser plus our own sourcepos-driven printer.
//!
//! A **sibling** to `mdstruct`, not built on it: `mdstruct::build_document`
//! allocates a comrak arena, walks it into a flat `Document` span index, and
//! drops the arena — per `mdstruct`'s "never restringify" axiom, nothing
//! outside that walk can reach the live AST. A printer needs the live AST, so
//! `mdformat` runs its own `comrak::parse_document` rather than consuming
//! `mdstruct::Document`.
//!
//! The two crates MUST still agree on how comrak parses, or a file that
//! passes `mdstruct check` could format differently than it lints — so this
//! crate takes its comrak configuration from [`mdstruct::comrak_options`]
//! rather than re-deriving equivalent settings. [`comrak_options`] below is a
//! thin forwarding wrapper, not a second source of truth; `tests::` asserts
//! the two agree, guarding against a future edit that re-derives instead of
//! delegating.
//!
//! # Milestone 1: the partition, not the reformat
//!
//! [`partition`] changes nothing about any file's bytes. It parses, claims a
//! byte range for each top-level block, and proves those ranges form a
//! partition of the file's content bytes — every non-whitespace byte in
//! exactly one block span, no overlaps, nothing past the end. That property,
//! not byte-exact reassembly, is what a later milestone needs: a formatter
//! that rewrites one block (table padding, list marker unification) splices
//! its replacement over that block's range, and only a partition guarantees
//! the splice neither drops nor duplicates the rest of the file. The partition
//! is therefore the *whole* of [`partition`]'s verdict. Reassembly equality is
//! no part of it, because it holds for every span set including corrupt ones —
//! [`print`]'s module docs explain why, and two tests hold the trap open.
//!
//! # The first rewrite, and the oracle it needed
//!
//! [`normalize`] is the first thing here that changes bytes: it rewrites the
//! whitespace *between* top-level blocks to a blank-line normal form. It is
//! **opt-in and default-off** — the CLI reaches it through `format --rule gaps`,
//! which reports under `--check` and otherwise emits to stdout, and reaches no
//! file. Only [`write`] opens a file, and only for the single target the
//! section below describes.
//!
//! It does not run on the partition oracle either. That oracle is a unary
//! invariant of one document, so it cannot tell a faithful rewrite from an
//! unfaithful one, and measurement bears that out: it passed on 167 of 167
//! synthetic documents whose parse the rewrite destroyed. What guards a rewrite
//! is [`structure`] — re-parse structural equivalence over block kinds, nesting,
//! node attributes, and rendered HTML. The partition's role is a *precondition*:
//! it is what makes the gap between two blocks definable as whitespace at all.
//!
//! # The second rewrite
//!
//! [`table`] pads every table's cells to their column's terminal display width,
//! except a trailing column whose alignment does not need the fill.
//! It is opt-in and default-off on the same terms, and it carries a second,
//! transformation-specific oracle: outside the delimiter row, whose dash count
//! is the one thing padding is defined to change, every line's non-whitespace
//! bytes must survive byte-identical, and no cell's space-trimmed content may
//! move. It also forced [`structure`] to grow a fourth signature, because the
//! tree alone cannot see a table row gain or lose a cell.
//!
//! # The third rewrite, and the oracle it must not have
//!
//! [`endings`] rewrites every line ending to LF. It is the only rewrite here
//! that reaches **inside** a block's span, and the only one carrying no oracle.
//! Both follow from the same fact: every carriage return is a CommonMark line
//! ending, so the map is total and context-free and its effect is fixed by its
//! own statement. The structure oracle would refuse it — comrak stores line
//! endings verbatim in a code-block, HTML-block and front-matter literal — and
//! an oracle blind to the bytes it changes could never fail. So it carries a
//! measurement instead of a guard, and it runs first, which is what keeps the
//! other two rules' inputs free of carriage returns.
//!
//! It exists because without it the composition emitted **mixed** endings: the
//! gap rule states its separators as LF literals, so a CRLF gap was already
//! rewritten, while a CRLF inside a paragraph is span interior and survived.
//!
//! # The fourth rewrite, born under the contract
//!
//! [`markers`] unifies every bullet to `-` and every ordered delimiter to `.`.
//! It is the first rule here written against [`format`]'s contract rather than
//! retrofitted into it, and the first that is **preservative**: a census found
//! the vault unanimous on both markers, so its expected corrective effect on
//! today's corpus is zero files, and zero is what it is supposed to do.
//!
//! It rewrites content bytes, so it cannot inherit the gap rule's cheap
//! faithfulness argument and carries [`structure`] like [`table`] does — with
//! one exemption, spelled at the call site rather than inside the signature:
//! `bullet_char` and `delimiter` moved out of the oracle's `rich` rendering
//! into a `markers` one, and this is the only rule that compares the other four
//! and not that one. It also carries a per-construct declination, because in
//! CommonMark a change of bullet character starts a new list, so unifying two
//! adjacent lists with different markers **merges** them.
//!
//! # The composition, and what "already formatted" means
//!
//! [`format`] applies every rule in [`format::RULES`] in one pass. [`check`]
//! answers the other half: whether a document is already in normal form, and
//! where it is not. Both take the rule list as a parameter
//! ([`format::format_with`], [`format::check_with`]), which is what the CLI's
//! `--rule <name>` selects when one rule is wanted on its own.
//!
//! The predicate is not written beside the rules. It is **derived from them** —
//! a document is normal for a rule exactly when the rule's own yield for it is
//! the document unchanged — so a construct a rule declines is exempt by
//! construction rather than by a second list someone has to keep in step. The
//! [`format`] module's docs argue why that is the only correspondence that
//! cannot drift. Like every rewrite here, the composition itself writes no
//! file: it returns bytes, and [`write`] is what puts them anywhere.
//!
//! # The one write, and the tier it is
//!
//! [`write`] is the only module that opens a file for writing, and it admits
//! **exactly one file, named on the command line, at a time** — `format
//! --write <file>`. A second path, a directory, a shell glob, or stdin is
//! refused by [`write::target`] before a byte is read.
//!
//! That is not caution about the code; every rule's bytes already cleared its
//! oracle. It is caution about *scale*. A rewrite a person chose, is looking
//! at, and can undo by hand is inspected; a rewrite of a tree is trusted, and
//! being trustworthy is a property of the corpus's recoverability — versioning,
//! a restore actually performed, a dry run read — which no assertion in this
//! crate can observe. So the boundary is a refusal in code rather than a rule
//! in a README, and widening it has to be an edit to [`write`].
//!
//! Under that single-file tier, [`format`]'s declinations stop being a footnote
//! and become the product: the CLI reports every rule that declined the
//! document and every construct a rule left verbatim, unconditionally, because
//! the person reading the result is the reason this tier is allowed at all.

use comrak::Arena;
use comrak::nodes::AstNode;

pub mod anchor;
pub mod bom;
pub mod endings;
pub mod format;
pub mod markers;
pub mod normalize;
pub mod print;
pub mod span;
pub mod structure;
pub mod table;
pub mod write;

pub use bom::BOM;
pub use endings::{EndingChange, LineEndings, to_lf};
pub use format::{
    Check, Departure, Exemption, Format, Rule, RuleRun, check, check_with, escape_whitespace,
    format, format_with, rule_named, rule_names,
};
pub use markers::{
    ListSkipReason, MarkerChange, MarkerViolation, SkippedList, Unification, marker_violation,
    unify,
};
pub use normalize::{GapChange, Normalization, normalize};
pub use print::{
    Block, PartitionReport, Violation, block_kind, block_spans, check_partition, reassemble,
};
pub use span::{LineIndex, PosError, PosReason};
pub use structure::{Structure, StructureDiff, structure_of};
pub use table::{
    LineChange, PadViolation, PadViolationKind, Padding, SkipReason, SkippedTable, pad,
};
pub use write::{Refusal, replace, target};

/// `mdformat`'s comrak parse configuration. Forwards to
/// [`mdstruct::comrak_options`] verbatim — `mdformat` has no comrak settings
/// of its own. Keeping this as a real (if thin) function, rather than callers
/// reaching for `mdstruct::comrak_options` directly, gives the crate one
/// named seam to audit and to hold `tests::comrak_options_agrees_with_mdstruct`
/// against.
pub fn comrak_options(opts: &mdstruct::Options) -> comrak::Options<'static> {
    mdstruct::comrak_options(opts)
}

/// Parse `source` into `arena` under the shared comrak configuration, and
/// hand the live root node to `f`. The arena has to outlive the callback (the
/// AST borrows from it), so this takes the shape of a scoped callback rather
/// than returning the node directly.
///
/// One correction runs between the parse and the callback:
/// [`anchor::repair_table_columns`] re-anchors the columns comrak carries from a
/// table's opening line onto its later rows, which land wherever the header
/// opened rather than where they are. It lives here, and not in one reader,
/// because two readers consume those columns — [`print::block_spans`] converts
/// them to byte ranges and [`table::pad`] slices the source at them — so a
/// correction in either alone would leave the other reading the wrong bytes.
/// That module states the measured boundary of what it touches.
pub fn parse_with<'a, R>(
    arena: &'a Arena<'a>,
    source: &str,
    opts: &mdstruct::Options,
    f: impl FnOnce(&'a AstNode<'a>) -> R,
) -> R {
    let options = comrak_options(opts);
    let root = comrak::parse_document(arena, source, &options);
    anchor::repair_table_columns(root, source);
    f(root)
}

/// One file's partition result: the block spans and the verdict on them.
#[derive(Debug, Clone)]
pub struct Partition {
    pub blocks: Vec<Block>,
    pub report: PartitionReport,
}

impl Partition {
    /// A file passes when its blocks partition its content bytes. That is the
    /// whole verdict.
    ///
    /// It carried a second conjunct until this commit — that
    /// [`print::reassemble`]'s output equals the input — which no file could
    /// ever fail. `reassemble` walks the source with a monotone cursor,
    /// emitting the gap before each block and then the block, so it returns its
    /// input for *any* span set, corrupt ones included. A conjunct true whatever
    /// the spans are constrains nothing, and one that reads like a second
    /// safeguard is worse than no second safeguard: it invites a reader to
    /// believe the verdict is doubly grounded when it rests entirely on
    /// [`PartitionReport::is_partition`]. [`print`] argues this at length;
    /// `print::reassemble_is_boundary_insensitive_by_construction` and
    /// `tests/partition.rs::reassembly_alone_misses_what_the_partition_catches`
    /// pin it, and are what anyone restoring the conjunct has to delete first.
    pub fn passed(&self) -> bool {
        self.report.is_partition()
    }
}

/// Parse `source` under the shared configuration, tile it with the byte range
/// of each top-level block, and report whether those ranges partition its
/// content bytes.
///
/// Runs no reassembly. [`reassemble`] returns its input for any span set, so
/// calling it here would allocate a second copy of every file in a corpus run
/// to confirm a tautology. A caller wanting the printer's bytes calls
/// [`reassemble`] itself.
///
/// `Err` carries every sourcepos that does not name a byte range in `source`;
/// unlike `mdstruct`, an out-of-range position is never clamped.
pub fn partition(source: &str, opts: &mdstruct::Options) -> Result<Partition, Vec<PosError>> {
    let arena = Arena::new();
    parse_with(&arena, source, opts, |root| {
        let blocks = block_spans(root, source)?;
        let report = check_partition(source, &blocks);
        Ok(Partition { blocks, report })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `mdformat` must get its parse configuration by calling
    /// `mdstruct::comrak_options`, not by re-deriving equivalent settings —
    /// otherwise the formatter and the linter could silently drift onto
    /// different comrak behavior. `comrak::Options` has no `PartialEq`, so
    /// this compares the `Debug` rendering instead.
    #[test]
    fn comrak_options_agrees_with_mdstruct() {
        let opts = mdstruct::Options::default();
        let ours = format!("{:?}", comrak_options(&opts));
        let theirs = format!("{:?}", mdstruct::comrak_options(&opts));
        assert_eq!(
            ours, theirs,
            "mdformat's comrak options must match mdstruct's exactly"
        );
    }

    #[test]
    fn partition_passes_and_accounts_for_every_content_byte() {
        let src = "# Heading\n\nSome *text* with a [[Wikilink]].\n";
        let opts = mdstruct::Options::default();
        let r = partition(src, &opts).expect("spans convert");
        assert!(r.passed(), "{:?}", r.report.violations);
        assert_eq!(r.report.content_bytes, r.report.covered_content_bytes);
    }
}
