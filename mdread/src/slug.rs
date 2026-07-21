//! Heading slugs — the address scheme the reader owns. One label in (a heading's
//! text), one kebab slug out: drop wikilink syntax, strip `` ` ``/`*`/`_`,
//! lowercase, map every run of non-alphanumerics to a single `-`, trim dashes.

use crate::wikilink;

/// Slugify a single heading label. The label carries no path-segment boundary,
/// so any `/` it happens to contain collapses like other punctuation.
pub fn segment(text: &str) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(segment("See [[A Note|Display]]"), "see-display");
    }

    #[test]
    fn segment_collapses_ambiguous_punctuation() {
        assert_eq!(segment("Log & Notes"), "log-notes");
        assert_eq!(segment("Log Notes"), "log-notes");
    }
}
