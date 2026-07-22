//! Reserved-address shadowing: which headings answer to a reserved name.
//!
//! Reserved names (`0`/`text`, `fm`/`frontmatter`, `links`) are matched before
//! the heading tree, so a `## Links` section is unreachable by its slug. That
//! precedence stands — one address, one meaning — and this module makes the
//! collision audible instead of silent. One tree walk answers the question for
//! every consumer: the overview footer, the note printed when a reserved reading
//! is served over a live shadow, and the two errors a reserved address raises
//! when it resolves to nothing.

use crate::model::{Document, Node, flatten};

/// A heading whose slug equals a reserved name.
pub(crate) struct Shadow {
    pub(crate) heading: String,
    /// The heading's dotted-numeric address — the way still open to reach it.
    pub(crate) address: String,
}

/// The reserved names a heading slug can collide with, grouped by the reading
/// they name: `0`/`text` are one reading, as are `fm`/`frontmatter`. A heading
/// shadows a reading rather than a spelling, so a caller who typed `fm` hears
/// about a `## Frontmatter` section — the answer served is the same either way.
///
/// `fm.<path>` is absent on purpose: a dotted path is not a slug, so no heading
/// shadows it.
const FAMILIES: [&[&str]; 3] = [&["0", "text"], &["fm", "frontmatter"], &["links"]];

/// Every reserved name, across families.
pub(crate) fn reserved_names() -> impl Iterator<Item = &'static str> {
    FAMILIES.iter().flat_map(|f| f.iter().copied())
}

/// The names sharing a reading with `address`, or `None` when `address` is not a
/// bare reserved name.
fn family(address: &str) -> Option<&'static [&'static str]> {
    FAMILIES
        .iter()
        .copied()
        .find(|f| f.iter().any(|n| address.eq_ignore_ascii_case(n)))
}

/// Headings that slug to `address`, in document order.
///
/// The single shadowing tree walk. `address` is slugged the same way a heading
/// is, so `Links`, `LINKS`, and `links` ask one question.
pub(crate) fn shadowing_headings(doc: &Document, address: &str) -> Vec<Shadow> {
    let needle = crate::slug::segment(address);
    let mut all: Vec<&Node> = Vec::new();
    flatten(&doc.tree, &mut all);
    all.into_iter()
        .filter(|n| n.slug == needle)
        .map(|n| Shadow {
            heading: n.heading.clone(),
            address: n.address.clone(),
        })
        .collect()
}

/// The clause naming what else answers to the reading `address` asked for:
/// `heading 'Links' (1.1) also answers to 'links'`, one clause per shadowing
/// heading joined with `; `. The quoted name is the reserved word the heading
/// slugs to, which is the typed address except when the caller used the other
/// spelling of the same reading.
///
/// `None` when `address` is not a bare reserved name (a `fm.<path>` value
/// address included) or when no heading slugs to one. The caller prefixes it
/// with `note: ` on stderr, or appends it to a reserved-address error.
pub(crate) fn phrase(doc: &Document, address: &str) -> Option<String> {
    let clauses: Vec<String> = family(address)?
        .iter()
        .copied()
        .flat_map(|name| {
            shadowing_headings(doc, name).into_iter().map(move |s| {
                format!(
                    "heading '{}' ({}) also answers to '{}'",
                    s.heading, s.address, name
                )
            })
        })
        .collect();
    if clauses.is_empty() {
        return None;
    }
    Some(clauses.join("; "))
}

/// Overview footer lines: one complete `note: …` line per heading that answers
/// to a reserved name. Empty when the document has no collision, which is the
/// common case, so the overview grows nothing.
pub(crate) fn overview_notes(doc: &Document) -> Vec<String> {
    reserved_names()
        .flat_map(|r| shadowing_headings(doc, r))
        .map(|s| {
            format!(
                "note: '{}' ({}) also answers to a reserved address; reach it by number",
                s.heading, s.address
            )
        })
        .collect()
}
