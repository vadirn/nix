//! `mdformat` — comrak's parser plus (eventually) our own printer.
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
//! A confirmed experiment underpins the printer step that comes next: a
//! printer that emits the original source bytes for every node span, plus
//! the whitespace gap bytes between spans, reconstructs a file byte-exactly,
//! because comrak's own printer never reads sourcepos — comrak populates
//! `Ast::sourcepos` unconditionally, independent of `render.sourcepos`. That
//! printer is not built yet; [`fixpoint_stub`] is scaffolding for it.

use comrak::Arena;
use comrak::nodes::AstNode;

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

/// Stub for the eventual printer. Parses `source` under the shared
/// configuration (proving the wiring end to end) and returns the input
/// unchanged. The real printer replaces the body of the callback with a walk
/// that emits each node's span plus the gap bytes between spans; until then,
/// the identity transform trivially satisfies `print(parse(f)) == f` because
/// it never touches the bytes.
pub fn fixpoint_stub(source: &str, opts: &mdstruct::Options) -> String {
    let arena = Arena::new();
    parse_with(&arena, source, opts, |_root| {
        // TODO(printer): walk `_root`, emit each node's source span and the
        // whitespace gaps between spans, and drop this passthrough.
        source.to_string()
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
    fn fixpoint_stub_is_identity_for_now() {
        let src = "# Heading\n\nSome *text* with a [[Wikilink]].\n";
        let opts = mdstruct::Options::default();
        assert_eq!(fixpoint_stub(src, &opts), src);
    }
}
