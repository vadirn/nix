//! Reserved addresses: what they name, and which headings collide with them.
//!
//! Reserved names (`0`/`text`, `fm`/`frontmatter`, `links`) are matched before
//! the heading tree, so a `## Links` section is unreachable by its slug. That
//! precedence stands — one address, one meaning — and this module makes the
//! collision audible instead of silent. [`reserved_reading`] is the single
//! definition of what a reserved address is: the dispatch matches on it to pick
//! a reading, and the announcements ask it of a heading's slug. One tree walk
//! answers the question for every consumer: the overview footer, the note
//! printed when a reserved reading is served over a live shadow, and the two
//! errors a reserved address raises when it resolves to nothing.

use crate::model::{Document, Node, flatten};

/// Which part of the frontmatter an address names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum FmAddress<'a> {
    /// The whole block (`frontmatter`, `fm`).
    Block,
    /// One value by path (`fm.tags`, `fm.references[0].target`).
    Path(&'a str),
}

/// A reading reachable only by a reserved address — a part of the file the
/// heading tree cannot name.
///
/// Two spellings of one reading produce one variant, which is what makes the
/// shadow question answerable without a table of names: a `## Frontmatter`
/// heading and the address `fm` meet at [`Reading::Fm`]. Variant order is the
/// order the overview footer reports collisions in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Reading<'a> {
    /// The lede above the first heading (`0`, `text`).
    Text,
    /// The frontmatter block, or one value inside it.
    Fm(FmAddress<'a>),
    /// The outgoing-link list (`links`).
    Links,
}

/// The reading `addr` names, or `None` when it belongs to the heading tree.
///
/// Case-insensitive throughout. The frontmatter prefixes are ASCII, so
/// lowercasing preserves their byte length and the path can be sliced out of
/// the original (case-preserving) address — YAML keys are case-sensitive, so
/// the path must not be lowercased with the prefix.
pub(crate) fn reserved_reading(addr: &str) -> Option<Reading<'_>> {
    if addr == "0" || addr.eq_ignore_ascii_case("text") {
        return Some(Reading::Text);
    }
    if addr.eq_ignore_ascii_case("links") {
        return Some(Reading::Links);
    }
    let lower = addr.to_lowercase();
    if lower == "frontmatter" || lower == "fm" {
        return Some(Reading::Fm(FmAddress::Block));
    }
    for prefix in ["frontmatter.", "fm."] {
        if lower.starts_with(prefix) {
            let path = &addr[prefix.len()..];
            if !path.is_empty() {
                return Some(Reading::Fm(FmAddress::Path(path)));
            }
        }
    }
    None
}

/// A heading whose slug is itself a reserved address.
pub(crate) struct Shadow {
    pub(crate) heading: String,
    /// The heading's dotted-numeric address — the way still open to reach it.
    pub(crate) address: String,
    /// The reserved word the heading slugs to, quoted in the clause. It is the
    /// typed address except when the caller used the other spelling of the same
    /// reading.
    pub(crate) name: String,
}

/// Every heading whose slug names a reserved reading, in document order.
///
/// The single shadowing tree walk. A slug carries no dots, so no heading can
/// name an `fm.<path>` value address — asking [`reserved_reading`] of a slug
/// yields [`FmAddress::Block`] or nothing.
fn shadows<'d>(doc: &'d Document<'_>) -> Vec<(Reading<'d>, &'d Node)> {
    let mut all: Vec<&Node> = Vec::new();
    flatten(&doc.tree, &mut all);
    all.into_iter()
        .filter_map(|n| reserved_reading(&n.slug).map(|r| (r, n)))
        .collect()
}

impl Shadow {
    fn of(n: &Node) -> Shadow {
        Shadow {
            heading: n.heading.clone(),
            address: n.address.clone(),
            name: n.slug.clone(),
        }
    }
}

/// Headings that shadow `reading`, in document order.
pub(crate) fn shadowing_headings(doc: &Document, reading: Reading<'_>) -> Vec<Shadow> {
    shadows(doc)
        .into_iter()
        .filter(|(r, _)| *r == reading)
        .map(|(_, n)| Shadow::of(n))
        .collect()
}

/// The clause naming what else answers to the reading `address` asked for:
/// `heading 'Links' (1.1) also answers to 'links'`, one clause per shadowing
/// heading joined with `; `.
///
/// `None` when `address` is not a reserved address, or when no heading shadows
/// the reading it names — a `fm.<path>` value address included, since no slug
/// names one. The caller prefixes it with `note: ` on stderr, or appends it to
/// a reserved-address error.
pub(crate) fn phrase(doc: &Document, address: &str) -> Option<String> {
    let reading = reserved_reading(address)?;
    let clauses: Vec<String> = shadowing_headings(doc, reading)
        .into_iter()
        .map(|s| {
            format!(
                "heading '{}' ({}) also answers to '{}'",
                s.heading, s.address, s.name
            )
        })
        .collect();
    if clauses.is_empty() {
        return None;
    }
    Some(clauses.join("; "))
}

/// Overview footer lines: one complete `note: …` line per heading that answers
/// to a reserved address. Empty when the document has no collision, which is the
/// common case, so the overview grows nothing.
///
/// Grouped by reading — the order [`Reading`] declares — and within a reading by
/// document order, so the footer reads as one line per reserved reading the tree
/// collides with rather than an interleaving.
pub(crate) fn overview_notes(doc: &Document) -> Vec<String> {
    let mut found = shadows(doc);
    found.sort_by(|a, b| a.0.cmp(&b.0));
    found
        .into_iter()
        .map(|(_, n)| {
            format!(
                "note: '{}' ({}) also answers to a reserved address; reach it by number",
                n.heading, n.address
            )
        })
        .collect()
}
