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
//! [`fixpoint`] changes nothing about any file's bytes. It parses, claims a
//! byte range for each top-level block, and proves those ranges form a
//! partition of the file's content bytes — every non-whitespace byte in
//! exactly one block span, no overlaps, nothing past the end. That property,
//! not byte-exact reassembly, is what a later milestone needs: a formatter
//! that rewrites one block (table padding, list marker unification) splices
//! its replacement over that block's range, and only a partition guarantees
//! the splice neither drops nor duplicates the rest of the file. Reassembly
//! equality comes along for free and proves nothing on its own — [`print`]'s
//! module docs explain why, and a test holds the trap open.

use comrak::Arena;
use comrak::nodes::AstNode;

pub mod print;
pub mod span;

pub use print::{
    Block, PartitionReport, Violation, block_kind, block_spans, check_partition, reassemble,
};
pub use span::{LineIndex, PosError, PosReason};

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
pub fn parse_with<'a, R>(
    arena: &'a Arena<'a>,
    source: &str,
    opts: &mdstruct::Options,
    f: impl FnOnce(&'a AstNode<'a>) -> R,
) -> R {
    let options = comrak_options(opts);
    let root = comrak::parse_document(arena, source, &options);
    f(root)
}

/// One file's fixpoint result: the block spans, the partition verdict, and the
/// printer's output.
#[derive(Debug, Clone)]
pub struct Fixpoint {
    pub blocks: Vec<Block>,
    pub partition: PartitionReport,
    pub output: String,
    /// Whether [`print::reassemble`]'s output equals the input. Necessary but
    /// far from sufficient — see [`print`].
    pub matches_input: bool,
}

impl Fixpoint {
    /// A file passes when its blocks partition its content bytes **and** the
    /// printer reproduces it. The first conjunct is the one that can fail.
    pub fn passed(&self) -> bool {
        self.partition.is_partition() && self.matches_input
    }
}

/// Parse `source` under the shared configuration, tile it with the byte range
/// of each top-level block, and report whether those ranges partition its
/// content bytes and reproduce it verbatim.
///
/// `Err` carries every sourcepos that does not name a byte range in `source`;
/// unlike `mdstruct`, an out-of-range position is never clamped.
pub fn fixpoint(source: &str, opts: &mdstruct::Options) -> Result<Fixpoint, Vec<PosError>> {
    let arena = Arena::new();
    parse_with(&arena, source, opts, |root| {
        let blocks = block_spans(root, source)?;
        let partition = check_partition(source, &blocks);
        let output = reassemble(source, &blocks);
        Ok(Fixpoint {
            matches_input: output == source,
            blocks,
            partition,
            output,
        })
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
    fn fixpoint_passes_and_accounts_for_every_content_byte() {
        let src = "# Heading\n\nSome *text* with a [[Wikilink]].\n";
        let opts = mdstruct::Options::default();
        let r = fixpoint(src, &opts).expect("spans convert");
        assert!(r.passed(), "{:?}", r.partition.violations);
        assert_eq!(r.output, src);
        assert_eq!(r.partition.content_bytes, r.partition.covered_content_bytes);
    }
}
