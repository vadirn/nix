//! Shared structural scanner for Markdown bodies.
//!
//! A single canonical implementation of the two primitives every body-walking
//! command needs: fenced-code detection ([`fence_marker`]) and ATX-heading
//! detection ([`atx_heading`] / [`heading_text`]). Previously `read`, `lint::relations`,
//! and `lint::nodes` each carried their own copy and the copies had drifted on
//! what counts as a heading. This module is the one source of truth; `read`'s
//! rules are canonical:
//!
//! - **Fences** are three-or-more of the same marker (`` ` `` or `~`). A line
//!   with a *different* marker while inside a fence is literal content, not a
//!   close (the caller's toggler enforces this — see the match in `read`'s
//!   `parse_document`).
//! - **Headings** are matched against the *raw* line: leading whitespace before
//!   the `#` disqualifies (so an indented `# x` is not a heading), and the hashes
//!   must be followed by a space or a tab.

/// If `trimmed` (already left-trimmed) opens or closes a fence, return its
/// marker char (backtick or tilde). A fence line is three or more of the same.
pub fn fence_marker(trimmed: &str) -> Option<char> {
    for marker in ['`', '~'] {
        if trimmed.starts_with(marker) {
            let count = trimmed.chars().take_while(|&c| c == marker).count();
            if count >= 3 {
                return Some(marker);
            }
        }
    }
    None
}

/// Parse an ATX heading line `^(#{1,6})[ \t](.+)$`. Leading whitespace before `#`
/// is not allowed (matches CommonMark's indented-code rule only loosely, but is
/// adequate for vault files and avoids treating `   # comment` as a heading).
/// Returns the heading level (1–6) and its trimmed text.
pub fn atx_heading(line: &str) -> Option<(usize, String)> {
    let text = heading_text(line)?;
    let level = line.bytes().take_while(|&b| b == b'#').count();
    Some((level, text.to_string()))
}

/// Borrowing form of [`atx_heading`] for callers that only need the heading text
/// (e.g. to slug it). Applies the same canonical rules: the `#` run starts at
/// column 0 (no leading whitespace), runs 1–6 deep, and is followed by a space or
/// tab; the returned slice is the trimmed text. `None` on a non-heading line.
pub fn heading_text(line: &str) -> Option<&str> {
    let bytes = line.as_bytes();
    let mut hashes = 0;
    while hashes < bytes.len() && bytes[hashes] == b'#' {
        hashes += 1;
    }
    if hashes == 0 || hashes > 6 {
        return None;
    }
    // Require at least one space/tab after the hashes, then non-empty text.
    let rest = &line[hashes..];
    if !rest.starts_with(' ') && !rest.starts_with('\t') {
        return None;
    }
    let text = rest.trim();
    if text.is_empty() { None } else { Some(text) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fence_marker_matches_three_or_more() {
        assert_eq!(fence_marker("```"), Some('`'));
        assert_eq!(fence_marker("````rust"), Some('`'));
        assert_eq!(fence_marker("~~~"), Some('~'));
        assert_eq!(fence_marker("``"), None);
        assert_eq!(fence_marker("text"), None);
    }

    #[test]
    fn heading_text_reads_levels_and_text() {
        assert_eq!(heading_text("# Title"), Some("Title"));
        assert_eq!(heading_text("###### Six"), Some("Six"));
        assert_eq!(heading_text("####### Seven"), None);
        assert_eq!(heading_text("#nospace"), None);
        assert_eq!(heading_text("not a heading"), None);
    }

    #[test]
    fn heading_text_allows_tab_after_hashes() {
        // Canonical (read) rule: a tab after the hashes is a valid separator.
        assert_eq!(heading_text("#\tTabbed"), Some("Tabbed"));
    }

    #[test]
    fn heading_text_rejects_leading_whitespace() {
        // Canonical (read) rule: detection runs against the raw line, so an
        // indented `#` is not a heading.
        assert_eq!(heading_text("  # Indented"), None);
        assert_eq!(heading_text("\t## Indented"), None);
    }

    #[test]
    fn atx_heading_returns_level_and_owned_text() {
        assert_eq!(atx_heading("## Two"), Some((2, "Two".to_string())));
        assert_eq!(atx_heading("  ## Indented"), None);
    }
}
