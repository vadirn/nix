//! Local-node parser — the "## Glossary = nodes" REBUILD primitive (D13/D22, STEP 3a).
//!
//! BUILD (`distill.ts::assembleBody`) renders a note's load-bearing concepts as a
//! `## Glossary` table and its actionable directives as a `## Workflow` numbered
//! list:
//!
//! ```text
//! ## Workflow
//!
//! 1. <step>
//!
//! ## Glossary
//!
//! | Term | Definition |
//! | ---- | ---------- |
//! | <term> | <def> |
//! ```
//!
//! This module is the REBUILD half: [`parse_local_nodes`] scans those two sections
//! back into a file's **local-node slug set** — the term-slugs (D28, via
//! [`crate::slug::segment`]) that a bare `Endpoint::Local` relation endpoint (D29)
//! resolves against. A Glossary row contributes its first-cell Term; a Workflow item
//! contributes its step text; both are slugged. The GFM header (`| Term | … |`) and
//! separator (`| ---- | … |`) rows carry no concept — collection starts only after
//! the separator, so the header is skipped without matching its literal text.
//!
//! Parsing mirrors [`super::relations`]'s scanner: fenced code is ignored, an ATX
//! heading opens its section, and the next heading of any level closes it. The two
//! section headings (`## Glossary`, `## Workflow`) are emitted in English by BUILD
//! regardless of the note's language, so the slug match is language-stable.

use crate::markdown::{fence_marker, heading_text};

/// The local-node slug set of one file: Glossary term-slugs and Workflow step-slugs,
/// each normalized by [`crate::slug::segment`]. These are the labels a bare local
/// relation endpoint or from-label (D29/D26) resolves against.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LocalNodes {
    /// Glossary term-slugs, in table order.
    pub terms: Vec<String>,
    /// Workflow step-slugs, in list order.
    pub steps: Vec<String>,
}

impl LocalNodes {
    /// Whether `slug` names a local node — a Glossary term or a Workflow step.
    /// The caller passes an already-slugged label; matching is exact.
    pub fn contains(&self, slug: &str) -> bool {
        self.terms.iter().any(|t| t == slug) || self.steps.iter().any(|s| s == slug)
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Section {
    None,
    Glossary,
    Workflow,
}

/// Parse the `## Glossary` table rows and `## Workflow` list items of `content` into
/// the file's local-node slug set.
pub fn parse_local_nodes(content: &str) -> LocalNodes {
    let mut nodes = LocalNodes::default();
    let mut section = Section::None;
    // GFM tables put a separator row between the header and the body; collection
    // begins only once that row is seen, latched per Glossary section entry.
    let mut seen_separator = false;
    let mut fence: Option<char> = None;

    for raw in content.lines() {
        let trimmed = raw.trim_start();

        // Skip fenced code blocks entirely. A mismatched marker inside a fence
        // is literal content, not a close (canonical `markdown` semantics).
        if let Some(marker) = fence_marker(trimmed) {
            match fence {
                None => fence = Some(marker),
                Some(open) if open == marker => fence = None,
                Some(_) => {}
            }
            continue;
        }
        if fence.is_some() {
            continue;
        }

        // A heading switches sections; reset the table latch on each entry.
        // Detection runs against the raw line, so an indented heading is not a
        // section boundary.
        if let Some(text) = heading_text(raw) {
            section = match crate::slug::segment(text).as_str() {
                "glossary" => Section::Glossary,
                "workflow" => Section::Workflow,
                _ => Section::None,
            };
            seen_separator = false;
            continue;
        }

        match section {
            Section::Glossary => {
                if is_separator_row(trimmed) {
                    seen_separator = true;
                    continue;
                }
                if !seen_separator {
                    // Header row (or blank) before the separator — not a body row.
                    continue;
                }
                if let Some(term) = first_cell(trimmed) {
                    let slug = crate::slug::segment(term);
                    if !slug.is_empty() {
                        nodes.terms.push(slug);
                    }
                }
            }
            Section::Workflow => {
                if let Some(step) = workflow_item_step(trimmed) {
                    let slug = crate::slug::segment(step);
                    if !slug.is_empty() {
                        nodes.steps.push(slug);
                    }
                }
            }
            Section::None => {}
        }
    }

    nodes
}

/// A GFM separator row: a table row whose every cell is only `-`/`:` (alignment
/// markers). `| ---- | ---------- |` matches; a body or header row does not.
fn is_separator_row(trimmed: &str) -> bool {
    let Some(inner) = trimmed.strip_prefix('|') else {
        return false;
    };
    let cells: Vec<&str> = inner.trim_end_matches('|').split('|').collect();
    !cells.is_empty()
        && cells.iter().all(|c| {
            let c = c.trim();
            !c.is_empty() && c.chars().all(|ch| ch == '-' || ch == ':')
        })
}

/// The first table cell of a row: the text after the leading `|` up to the next
/// UNESCAPED `|`, trimmed. distill escapes a literal pipe inside a cell as `\|`
/// (`escCell`), so a naive split on `|` would truncate a term containing one.
/// Returns `None` on a non-table line or an empty first cell.
fn first_cell(trimmed: &str) -> Option<&str> {
    let inner = trimmed.strip_prefix('|')?;
    let mut prev_backslash = false;
    let mut end = inner.len();
    for (i, ch) in inner.char_indices() {
        if ch == '|' && !prev_backslash {
            end = i;
            break;
        }
        prev_backslash = ch == '\\' && !prev_backslash;
    }
    let cell = inner[..end].trim();
    (!cell.is_empty()).then_some(cell)
}

/// The step text of a Workflow list item: the body after an ordered (`1. `, `2) `)
/// or unordered (`- `, `* `, `+ `) marker, trimmed. distill emits ordered items;
/// the unordered forms are accepted for hand-authored notes. Returns `None` on a
/// non-list line.
fn workflow_item_step(trimmed: &str) -> Option<&str> {
    if let Some(rest) = strip_ordered_marker(trimmed) {
        let s = rest.trim();
        return (!s.is_empty()).then_some(s);
    }
    for marker in ["- ", "* ", "+ "] {
        if let Some(rest) = trimmed.strip_prefix(marker) {
            let s = rest.trim();
            return (!s.is_empty()).then_some(s);
        }
    }
    None
}

/// Strip a leading ordered-list marker (`<digits>.` or `<digits>)` followed by a
/// space) and return the remainder, or `None`.
fn strip_ordered_marker(s: &str) -> Option<&str> {
    let digits_end = s.find(|c: char| !c.is_ascii_digit())?;
    if digits_end == 0 {
        return None;
    }
    let after = &s[digits_end..];
    let after = after.strip_prefix('.').or_else(|| after.strip_prefix(')'))?;
    after.strip_prefix(' ')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_glossary_terms_skipping_header_and_separator() {
        let md = "## Glossary\n\n| Term | Definition |\n| ---- | ---------- |\n| Target distance | how far |\n| Aim point | where the sight rests |\n";
        let nodes = parse_local_nodes(md);
        assert_eq!(nodes.terms, vec!["target-distance", "aim-point"]);
        assert!(nodes.steps.is_empty());
    }

    #[test]
    fn parses_workflow_steps() {
        let md = "## Workflow\n\n1. Range the target\n2. Hold over the aim point\n";
        let nodes = parse_local_nodes(md);
        assert_eq!(
            nodes.steps,
            vec!["range-the-target", "hold-over-the-aim-point"]
        );
        assert!(nodes.terms.is_empty());
    }

    #[test]
    fn header_term_is_not_a_node() {
        // The literal header cell "Term" must not slug to a `term` node.
        let md = "## Glossary\n\n| Term | Definition |\n| ---- | ---------- |\n| Real concept | def |\n";
        let nodes = parse_local_nodes(md);
        assert_eq!(nodes.terms, vec!["real-concept"]);
        assert!(!nodes.contains("term"));
    }

    #[test]
    fn ignores_rows_outside_glossary_and_workflow() {
        let md = "## Other\n\n| Term | Def |\n| ---- | --- |\n| Stray | x |\n\n1. not a workflow step\n";
        let nodes = parse_local_nodes(md);
        assert!(nodes.terms.is_empty());
        assert!(nodes.steps.is_empty());
    }

    #[test]
    fn section_closes_at_next_heading() {
        let md = "## Glossary\n\n| Term | Def |\n| ---- | --- |\n| In scope | x |\n\n## Notes\n\n| Out | y |\n";
        let nodes = parse_local_nodes(md);
        assert_eq!(nodes.terms, vec!["in-scope"]);
    }

    #[test]
    fn ignores_table_inside_fenced_code() {
        let md = "## Glossary\n\n```\n| Term | Def |\n| ---- | --- |\n| Fenced | x |\n```\n\n| Term | Def |\n| ---- | --- |\n| Real | y |\n";
        let nodes = parse_local_nodes(md);
        assert_eq!(nodes.terms, vec!["real"]);
    }

    #[test]
    fn term_with_escaped_pipe_slugs_like_the_raw_term() {
        // `escCell` writes a literal pipe as `\|`; the slug must match BUILD's slug
        // of the raw term `A | B` (both collapse the punctuation run to one dash).
        let md = "## Glossary\n\n| Term | Def |\n| ---- | --- |\n| A \\| B | x |\n";
        let nodes = parse_local_nodes(md);
        assert_eq!(nodes.terms, vec!["a-b"]);
        assert_eq!(nodes.terms[0], crate::slug::segment("A | B"));
    }

    #[test]
    fn contains_spans_terms_and_steps() {
        let md = "## Workflow\n\n1. Range the target\n\n## Glossary\n\n| Term | Def |\n| ---- | --- |\n| Aim point | x |\n";
        let nodes = parse_local_nodes(md);
        assert!(nodes.contains("aim-point"));
        assert!(nodes.contains("range-the-target"));
        assert!(!nodes.contains("windage"));
    }

    #[test]
    fn indented_glossary_heading_does_not_open_section() {
        // Semantics change (Step 1): the shared `markdown` heading rule runs
        // against the raw line, so an indented `## Glossary` is no longer a
        // section boundary and its rows are not collected. The pre-Step-1 copy
        // trimmed first and would have collected `concept`.
        let md = "  ## Glossary\n\n| Term | Def |\n| ---- | --- |\n| Concept | x |\n";
        let nodes = parse_local_nodes(md);
        assert!(nodes.terms.is_empty());
    }

    #[test]
    fn tab_after_hashes_opens_glossary() {
        // A tab after the hashes is a valid separator under the canonical rule.
        let md = "##\tGlossary\n\n| Term | Def |\n| ---- | --- |\n| Concept | x |\n";
        let nodes = parse_local_nodes(md);
        assert_eq!(nodes.terms, vec!["concept"]);
    }

    #[test]
    fn parses_golden_node_fixture_to_expected_slug_set() {
        // The local-node round-trip contract (STEP 3a): the BUILD-shaped note rebuilds
        // to exactly this term + step slug set, which a relations endpoint resolves
        // against.
        let fixture = include_str!("../../../tests/fixtures/node-roundtrip.md");
        let nodes = parse_local_nodes(fixture);
        assert_eq!(nodes.terms, vec!["target-distance", "aim-point", "holdover"]);
        assert_eq!(
            nodes.steps,
            vec!["range-the-target", "hold-over-the-aim-point"]
        );
    }
}
