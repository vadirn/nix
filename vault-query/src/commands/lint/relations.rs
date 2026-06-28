//! Relations channel — the structural-edge round-trip (REBUILD side).
//!
//! BUILD (`distill.ts`) serializes structural edges into a `## Relations` block,
//! one edge per list item:
//!
//! ```text
//! - <from-label> <rel>:: <to-endpoint> (predicate)
//! ```
//!
//! This module is the REBUILD half: [`parse_relations`] scans those lines back
//! into [`RelationEdge`]s. Parsing is **lossy** (D29) — a malformed line yields
//! no edge and never aborts the rebuild.
//!
//! The relations channel is an OPEN string set: a `<rel>` token is whitespace-free
//! and registry-soft-checked. This module owns the Rust-native copy of that
//! registry. `distill.ts` holds the TS-native copy; `rel-registry.json` (sibling
//! file) is the test-only canonical ground truth. Neither tool reads the JSON at
//! runtime — membership checks hit [`REL_REGISTRY`] directly. The `registry_parity`
//! test pins this const to the JSON; `distill.test.ts` pins its const to the same
//! JSON. Each side owns its own assertion, so the two copies cannot drift silently.
//!
//! Channel exclusions (D32): `supersedes` lives in file-grain frontmatter
//! (`superseded_by:`) and `contradicts` is merge-gated / curator-promoted. Neither
//! is a structural-channel token, so neither appears here.

/// Open relation vocabulary, structural channel only. Three tokens the extractor
/// already emits (subsumes / precondition-for / contrast-to, normalized to the
/// hyphenated form) plus four it is starting to emit (depends-on / part-of /
/// instance-of / refines). A `<rel>` token absent from this set is not an error;
/// the lint authority surfaces it as `unknown-rel` (Severity::Warn,
/// config-downgradable to Off) and keeps the edge.
pub const REL_REGISTRY: &[&str] = &[
    "subsumes",
    "precondition-for",
    "contrast-to",
    "depends-on",
    "part-of",
    "instance-of",
    "refines",
];

/// Soft registry membership (D32): a known `<rel>` is canonical; an unknown one is
/// kept as an edge and surfaced by the `unknown-rel` lint, never rejected.
pub fn is_known_rel(rel: &str) -> bool {
    REL_REGISTRY.contains(&rel)
}

/// An edge endpoint. Scope is marked by brackets in the source (D29): a bare
/// `term-slug` is local (another node in the same file), `[[file-slug]]` is a real
/// wikilink to another file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Endpoint {
    /// A bare local label (another Glossary/Workflow node in this file).
    Local(String),
    /// A `[[file-slug]]` target, raw (alias stripped, not yet resolved).
    File(String),
}

/// One parsed structural edge from a `## Relations` list item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelationEdge {
    /// Source node label; `None` on a single-atom card, which omits it (D26).
    pub from_label: Option<String>,
    /// The relation token (open vocabulary, registry-soft-checked).
    pub rel: String,
    /// The destination endpoint.
    pub endpoint: Endpoint,
    /// Optional trailing `(predicate)` free text.
    pub predicate: Option<String>,
    /// 1-based line number of the edge line.
    pub line: usize,
}

/// Parse every `## Relations` section's edge lines in `content`.
///
/// Lossy (D29): a line that is not a well-formed edge yields no edge and is
/// skipped, never aborting. Fenced code is ignored. A `## Relations` heading opens
/// the section; the next heading of any level closes it.
pub fn parse_relations(content: &str) -> Vec<RelationEdge> {
    let mut edges = Vec::new();
    let mut in_relations = false;
    let mut fence: Option<char> = None;

    for (idx, raw) in content.lines().enumerate() {
        let line_no = idx + 1;
        let trimmed = raw.trim_start();

        // Skip fenced code blocks entirely.
        if let Some(f) = fence {
            if trimmed.starts_with(f) && trimmed.chars().take_while(|&c| c == f).count() >= 3 {
                fence = None;
            }
            continue;
        }
        if trimmed.starts_with("```") {
            fence = Some('`');
            continue;
        }
        if trimmed.starts_with("~~~") {
            fence = Some('~');
            continue;
        }

        // A heading toggles section membership.
        if let Some(text) = heading_text(trimmed) {
            in_relations = crate::slug::segment(text) == "relations";
            continue;
        }

        if !in_relations {
            continue;
        }

        // A list item is a candidate edge.
        if let Some(edge) = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "))
            .and_then(|item| parse_edge_line(item, line_no))
        {
            edges.push(edge);
        }
    }

    edges
}

/// Return the text of an ATX heading line (`#{1,6} text`), or `None`.
///
/// Shared with [`super::nodes`], which runs the same fence/heading scanner to find
/// its `## Glossary` / `## Workflow` sections.
pub(crate) fn heading_text(trimmed: &str) -> Option<&str> {
    if !trimmed.starts_with('#') {
        return None;
    }
    let hashes = trimmed.chars().take_while(|&c| c == '#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    let after = &trimmed[hashes..];
    if !after.starts_with(' ') {
        return None;
    }
    let text = after.trim();
    if text.is_empty() { None } else { Some(text) }
}

/// Parse one edge list-item body (the text after the `- `).
fn parse_edge_line(item: &str, line: usize) -> Option<RelationEdge> {
    let (left, right) = item.split_once("::")?;
    let left = left.trim();
    let right = right.trim();
    if left.is_empty() || right.is_empty() {
        return None;
    }

    // `rel` is the last whitespace token of the left side; an optional `from-label`
    // is whatever precedes it (omitted on a single-atom card).
    let mut tokens: Vec<&str> = left.split_whitespace().collect();
    let rel = tokens.pop()?.to_string();
    let from_label = if tokens.is_empty() {
        None
    } else {
        Some(tokens.join(" "))
    };

    let (endpoint_str, predicate) = split_predicate(right);
    let endpoint = parse_endpoint(endpoint_str)?;

    Some(RelationEdge {
        from_label,
        rel,
        endpoint,
        predicate,
        line,
    })
}

/// Split a trailing `(predicate)` off the endpoint text, if present.
fn split_predicate(right: &str) -> (&str, Option<String>) {
    let right = right.trim();
    if let Some(open) = right.rfind('(').filter(|_| right.ends_with(')')) {
        let pred = right[open + 1..right.len() - 1].trim();
        let endpoint = right[..open].trim();
        let predicate = if pred.is_empty() {
            None
        } else {
            Some(pred.to_string())
        };
        return (endpoint, predicate);
    }
    (right, None)
}

/// Classify an endpoint by bracket scope (D29).
fn parse_endpoint(s: &str) -> Option<Endpoint> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    if let Some(inner) = s.strip_prefix("[[").and_then(|x| x.strip_suffix("]]")) {
        // `[[target|display]]` → target.
        let target = inner.split('|').next().unwrap_or(inner).trim();
        if target.is_empty() {
            return None;
        }
        Some(Endpoint::File(target.to_string()))
    } else {
        Some(Endpoint::Local(s.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    /// Registry parity: the Rust-native const must hold exactly the token set in the
    /// canonical `rel-registry.json`. Compiled in via `include_str!`, so a drift
    /// fails `cargo test` rather than slipping into a release.
    #[test]
    fn registry_parity() {
        let json = include_str!("rel-registry.json");
        let from_json: BTreeSet<String> =
            serde_json::from_str(json).expect("rel-registry.json must be a JSON array of strings");
        let from_const: BTreeSet<String> = REL_REGISTRY.iter().map(|s| s.to_string()).collect();
        assert_eq!(
            from_json, from_const,
            "REL_REGISTRY (relations.rs) drifted from rel-registry.json"
        );
    }

    #[test]
    fn parses_golden_fixture_to_expected_edges() {
        // The round-trip contract: BUILD emits this exact text, REBUILD parses it
        // back to this exact edge set.
        let fixture = include_str!("../../../tests/fixtures/relations-roundtrip.md");
        let edges = parse_relations(fixture);

        assert_eq!(edges.len(), 4, "fixture has 4 edges across 2 blocks");

        // Note block: from-label present, local + file endpoints, predicate present/absent.
        assert_eq!(edges[0].from_label.as_deref(), Some("target-distance"));
        assert_eq!(edges[0].rel, "precondition-for");
        assert_eq!(edges[0].endpoint, Endpoint::Local("aim-point".into()));
        assert_eq!(
            edges[0].predicate.as_deref(),
            Some("you must range before you can hold")
        );

        assert_eq!(edges[1].from_label.as_deref(), Some("aim-point"));
        assert_eq!(edges[1].rel, "subsumes");
        assert_eq!(edges[1].endpoint, Endpoint::Local("holdover".into()));
        assert_eq!(edges[1].predicate, None);

        assert_eq!(edges[2].from_label.as_deref(), Some("target-distance"));
        assert_eq!(edges[2].rel, "contrast-to");
        assert_eq!(
            edges[2].endpoint,
            Endpoint::File("note-line-of-sight".into())
        );
        assert_eq!(edges[2].predicate, None);

        // Card block: from-label omitted (single-atom card, D26), file endpoint.
        assert_eq!(edges[3].from_label, None);
        assert_eq!(edges[3].rel, "precondition-for");
        assert_eq!(edges[3].endpoint, Endpoint::File("note-graph-demo".into()));
        assert_eq!(
            edges[3].predicate.as_deref(),
            Some("holdover presupposes a ranged target")
        );

        // Line numbers are real and strictly increasing.
        assert!(edges[0].line > 0);
        for w in edges.windows(2) {
            assert!(w[1].line > w[0].line, "edge lines must increase");
        }
    }

    #[test]
    fn ignores_list_items_outside_a_relations_section() {
        let md = "## Other\n\n- foo bar:: baz\n\n## Relations\n\n- a subsumes:: b\n";
        let edges = parse_relations(md);
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].rel, "subsumes");
    }

    #[test]
    fn section_closes_at_next_heading() {
        let md = "## Relations\n\n- a subsumes:: b\n\n## Notes\n\n- c refines:: d\n";
        let edges = parse_relations(md);
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].endpoint, Endpoint::Local("b".into()));
    }

    #[test]
    fn lossy_skips_malformed_lines_without_aborting() {
        // A line with no `::` and an empty endpoint are both dropped; the valid
        // edge around them survives.
        let md = "## Relations\n\n- not an edge at all\n- a subsumes:: b\n- dangling rel::\n";
        let edges = parse_relations(md);
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].rel, "subsumes");
    }

    #[test]
    fn unknown_rel_is_parsed_and_kept() {
        // `relates-to` is not in REL_REGISTRY but still parses to an edge (lossy
        // never drops it; the lint surfaces it).
        let md = "## Relations\n\n- a relates-to:: b\n";
        let edges = parse_relations(md);
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].rel, "relates-to");
        assert!(!is_known_rel(&edges[0].rel));
    }

    #[test]
    fn alias_file_endpoint_strips_display() {
        let md = "## Relations\n\n- a contrast-to:: [[real-target|Display]]\n";
        let edges = parse_relations(md);
        assert_eq!(edges[0].endpoint, Endpoint::File("real-target".into()));
    }
}
