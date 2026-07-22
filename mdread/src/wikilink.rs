//! Minimal wikilink helpers the slugger needs: strip `[[…]]` markup from a label
//! down to its display text. Link *counting* comes from mdstruct inlines (see
//! [`crate::facet::link_count`]); this module only rewrites a heading string.

use std::sync::LazyLock;

use regex::Regex;

static WIKILINK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[\[([^\]|]+)(?:\|([^\]]*))?\]\]").unwrap());

/// Replace every `[[target|alias]]` with its alias and every `[[target]]` with
/// the resolved note name, so a heading carrying a wikilink slugs on the text a
/// reader sees.
pub fn strip(text: &str) -> String {
    WIKILINK_RE
        .replace_all(text, |caps: &regex::Captures| {
            caps.get(2)
                .map(|m| m.as_str().to_string())
                .unwrap_or_else(|| resolve_name(&caps[1]).to_string())
        })
        .to_string()
}

/// Resolve a wikilink target to a note name: drop any `#anchor`, take the last
/// `/`-separated segment, strip a trailing `.md`.
pub fn resolve_name(target: &str) -> &str {
    let without_anchor = target.split('#').next().unwrap_or(target);
    let last_segment = without_anchor.rsplit('/').next().unwrap_or(without_anchor);
    last_segment.strip_suffix(".md").unwrap_or(last_segment)
}
