//! Unified slug normalization for vault labels.
//!
//! One normalization core (`normalize_segment`) feeds two public grains:
//!
//! - [`segment`] — entry/heading/Glossary-term grain. The input is a single
//!   label with no `/`, so the core's `/`-destruction never bites.
//! - [`path`] — file grain. The input is a vault-relative path; it is split on
//!   `/`, each part is normalized by [`segment`], and the parts are rejoined
//!   with `/`, so the path-segment boundary survives.
//!
//! Invariant by construction: for any `/`-free text `t`, `path(t) == segment(t)`.
//! That single namespace is the D28 precondition — a Glossary term `Foo: Bar`
//! and a file titled `Foo: Bar` now reduce to the same slug `foo-bar`.

use crate::wikilink;

/// Normalize one label segment: drop wikilink syntax, strip backticks/`*`/`_`,
/// lowercase, map every run of non-alphanumerics to a single `-`, trim leading
/// and trailing `-`.
///
/// Maps `/` to `-` like any other non-alphanumeric, so it MUST only see a
/// single path segment. [`path`] enforces that by splitting on `/` first.
fn normalize_segment(text: &str) -> String {
    let stripped = wikilink::strip(text);
    let mut s = String::with_capacity(stripped.len());
    for ch in stripped.chars() {
        match ch {
            '`' | '*' | '_' => {}
            _ => s.push(ch),
        }
    }
    let lower = s.to_lowercase();
    let mut out = String::with_capacity(lower.len());
    let mut prev_dash = false;
    for ch in lower.chars() {
        if ch.is_alphanumeric() {
            out.push(ch);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

/// Slugify a single label (heading text, Glossary term, name fragment).
///
/// The label carries no path-segment boundary, so any `/` it happens to contain
/// is collapsed like other punctuation.
pub fn segment(text: &str) -> String {
    normalize_segment(text)
}

/// Slugify a vault-relative path, preserving `/` boundaries.
///
/// Each `/`-separated segment is normalized independently and the results are
/// rejoined with `/`. This keeps `41 projects/nix` → `41-projects/nix` instead
/// of collapsing the boundary into `41-projects-nix`.
pub fn path(rel: &str) -> String {
    rel.split('/')
        .map(normalize_segment)
        .collect::<Vec<_>>()
        .join("/")
}

/// Strip a trailing `.md` extension; leave all other dots intact.
pub fn strip_md(s: &str) -> &str {
    s.strip_suffix(".md").unwrap_or(s)
}

/// Resolve a slug to matching vault-relative paths.
///
/// Both the needle and each candidate path run through [`path`], so equality and
/// the segment-suffix test are evaluated in one namespace. The surviving `/`
/// makes the suffix test boundary-aware: needle `nix` matches `41-projects/nix`
/// (strip leaves `41-projects/`, ends in `/`) but not `book-of-phoenix` (strip
/// leaves `book-of-phoe`, no trailing `/`).
pub fn resolve_paths(slug: &str, cfg: &crate::config::ResolvedConfig) -> anyhow::Result<Vec<String>> {
    let vault_root = &cfg.vault_root;
    let files = crate::vault::scan(vault_root, vault_root, Some(&cfg.ignore))?;
    let needle = path(slug);
    let mut matches = Vec::new();

    for file in &files {
        let rel = file.relative_path(vault_root);
        let slugified = path(strip_md(&rel));

        let is_match = slugified == needle
            || slugified
                .strip_suffix(&needle)
                .is_some_and(|prefix| prefix.ends_with('/'));

        if is_match {
            matches.push(rel);
        }
    }
    Ok(matches)
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- strip_md (ported from the per-command twins) ---

    #[test]
    fn test_strip_md() {
        assert_eq!(strip_md("file.md"), "file");
        assert_eq!(strip_md("no-extension"), "no-extension");
        assert_eq!(strip_md("double.md.md"), "double.md");
    }

    // --- normalization core, ported from read.rs::heading_slug cases ---

    #[test]
    fn segment_core_cases() {
        assert_eq!(segment("Direction"), "direction");
        assert_eq!(segment("Sub one"), "sub-one");
        assert_eq!(segment("1. Numbered"), "1-numbered");
    }

    #[test]
    fn segment_strips_inline_markup() {
        assert_eq!(segment("`code` *bold*"), "code-bold");
    }

    #[test]
    fn segment_strips_wikilink_to_display() {
        // Ports read.rs:959.
        assert_eq!(segment("See [[A Note|Display]]"), "see-display");
    }

    #[test]
    fn segment_collapses_ambiguous_punctuation() {
        // Ports read.rs:956-957: both reduce to the same slug.
        assert_eq!(segment("Log & Notes"), "log-notes");
        assert_eq!(segment("Log Notes"), "log-notes");
    }

    // --- path grain: '/' survives, ports resolve.rs::test_slugify guarantees ---

    #[test]
    fn path_preserves_segment_boundary() {
        // Ports resolve.rs:43 verbatim.
        assert_eq!(path("41 projects/nix"), "41-projects/nix");
        assert_eq!(path("Impureim sandwich"), "impureim-sandwich");
        assert_eq!(path("already-lowercase"), "already-lowercase");
    }

    #[test]
    fn path_normalizes_each_nested_segment() {
        // '/' survives at each of the 2 boundaries AND the punctuated final
        // segment normalizes.
        assert_eq!(path("41 projects/nix/Foo: Bar"), "41-projects/nix/foo-bar");
    }

    // --- cross-grain parity: the D28 single-namespace requirement ---

    #[test]
    fn parity_segment_and_path_agree_on_slash_free_text() {
        for t in [
            "Impureim sandwich",
            "Foo: Bar",
            "Log & Notes",
            "`code` *bold*",
            "See [[A Note|Display]]",
            "1. Numbered",
        ] {
            assert_eq!(
                segment(t),
                path(t),
                "grains disagree on /-free text {t:?}"
            );
        }
    }

    #[test]
    fn parity_punctuation_normalizes_identically() {
        // A Glossary term `Foo: Bar` and a file titled `Foo: Bar` now yield the
        // same slug. The OLD naive file-grain slugify produced `foo:-bar`.
        assert_eq!(segment("Foo: Bar"), "foo-bar");
        assert_eq!(path("Foo: Bar"), "foo-bar");
    }

    // --- widening regression: the one behavioral break ---

    #[test]
    fn widening_file_grain_drops_punctuation() {
        // `Foo: Bar.md` formerly slugged `foo:-bar`; now `foo-bar`.
        assert_eq!(path(strip_md("Foo: Bar.md")), "foo-bar");
    }

    // --- segment-suffix matcher boundary behavior (logic, no vault scan) ---

    fn suffix_match(candidate: &str, needle: &str) -> bool {
        let slugified = path(candidate);
        let needle = path(needle);
        slugified == needle
            || slugified
                .strip_suffix(&needle)
                .is_some_and(|prefix| prefix.ends_with('/'))
    }

    #[test]
    fn boundary_positive_match() {
        // needle `nix` matches `41 projects/nix` (strip leaves `41-projects/`).
        assert!(suffix_match("41 projects/nix", "nix"));
    }

    #[test]
    fn boundary_negative_no_false_positive() {
        // needle `nix` must NOT match `book of phoenix` (strip leaves
        // `book-of-phoe`, no trailing '/').
        assert!(!suffix_match("book of phoenix", "nix"));
    }

    #[test]
    fn boundary_punctuated_query_matches_punctuated_path() {
        // 'Foo: Bar/nix' and the path both reduce to 'foo-bar/nix' and match.
        assert!(suffix_match("Foo: Bar/nix", "nix"));
        assert!(suffix_match("Foo: Bar/nix", "Foo: Bar/nix"));
    }
}
