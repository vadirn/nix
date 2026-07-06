//! The comment-anchor overlay scanner (Decision 12). Opt-in per caller-declared
//! label. Emits a `regions[]` entry for each `<!-- <label>[: <info>] -->` …
//! `<!-- /<label> -->` pair, each anchor on its own line. A region references a
//! span WITHOUT disturbing structure (the interior is still parsed into
//! `nodes[]`/`headings[]`), may overlap freely, and is excluded from tiling.
//!
//! Span convention (pinned by the region-slice check, Decision 17):
//!   span      = [line_start(open),   next_line_start(close))  — both anchor lines
//!   body_span = [line_start(open+1), line_start(close))       — raw bytes between

use super::model::{Region, Span};
use super::span::LineIndex;

/// One end of an anchor pair recognised on a single line.
enum Anchor<'a> {
    Open { label: &'a str, info: Option<&'a str> },
    Close { label: &'a str },
}

/// Parse a whole line as an anchor comment, or `None` if it is not one.
/// The comment must be the entire (trimmed) line content.
fn parse_anchor(line: &str) -> Option<Anchor<'_>> {
    let inner = line.trim().strip_prefix("<!--")?.strip_suffix("-->")?.trim();
    if let Some(rest) = inner.strip_prefix('/') {
        let label = rest.trim();
        if label.is_empty() {
            return None;
        }
        return Some(Anchor::Close { label });
    }
    let (label, info) = match inner.split_once(':') {
        Some((l, i)) => (l.trim(), Some(i.trim())),
        None => (inner, None),
    };
    if label.is_empty() {
        return None;
    }
    Some(Anchor::Open { label, info })
}

/// Scan `source` for registered region labels. Nested/overlapping regions are
/// supported via a per-label open stack; each close pops its most recent open.
pub fn scan(source: &str, idx: &LineIndex, labels: &[String]) -> Vec<Region> {
    if labels.is_empty() {
        return Vec::new();
    }
    let registered = |l: &str| labels.iter().any(|r| r == l);

    // Open anchors awaiting a close: (label, info, open_line_1based).
    let mut open_stack: Vec<(String, Option<String>, usize)> = Vec::new();
    let mut regions: Vec<Region> = Vec::new();

    for line_no in 1..=idx.line_count() {
        let start = idx.line_start(line_no);
        let end = idx.next_line_start(line_no);
        let line = &source[start..end];
        let Some(anchor) = parse_anchor(line) else {
            continue;
        };
        match anchor {
            Anchor::Open { label, info } if registered(label) => {
                open_stack.push((label.to_string(), info.map(str::to_string), line_no));
            }
            Anchor::Close { label } if registered(label) => {
                // Pop the most recent matching open.
                if let Some(pos) = open_stack.iter().rposition(|(l, _, _)| l == label) {
                    let (lbl, info, open_line) = open_stack.remove(pos);
                    let span = Span::new(idx.line_start(open_line), idx.next_line_start(line_no));
                    let body_span =
                        Span::new(idx.line_start(open_line + 1), idx.line_start(line_no));
                    regions.push(Region {
                        node_type: "region",
                        label: lbl,
                        info,
                        span,
                        body_span,
                        start_line: open_line as u32,
                        end_line: line_no as u32,
                    });
                }
            }
            _ => {}
        }
    }

    // Emit in source order of their opening anchor for determinism.
    regions.sort_by_key(|r| r.span.start);
    regions
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scans_one_region() {
        let src = "<!-- workflow: id=build -->\n- [ ] compile\n<!-- /workflow -->\n";
        let idx = LineIndex::new(src);
        let regions = scan(src, &idx, &["workflow".to_string()]);
        assert_eq!(regions.len(), 1);
        let r = &regions[0];
        assert_eq!(r.label, "workflow");
        assert_eq!(r.info.as_deref(), Some("id=build"));
        assert_eq!(r.start_line, 1);
        assert_eq!(r.end_line, 3);
        // body is exactly the bytes between the anchor lines.
        assert_eq!(&src[r.body_span.start..r.body_span.end], "- [ ] compile\n");
    }

    #[test]
    fn unregistered_label_is_ignored() {
        let src = "<!-- other -->\nx\n<!-- /other -->\n";
        let idx = LineIndex::new(src);
        assert!(scan(src, &idx, &["workflow".to_string()]).is_empty());
    }

    #[test]
    fn nested_same_and_different_labels() {
        let src = "<!-- a -->\n<!-- b -->\ninner\n<!-- /b -->\n<!-- /a -->\n";
        let idx = LineIndex::new(src);
        let regions = scan(src, &idx, &["a".to_string(), "b".to_string()]);
        assert_eq!(regions.len(), 2);
        // Outer `a` sorts first (opens earlier).
        assert_eq!(regions[0].label, "a");
        assert_eq!(regions[1].label, "b");
    }
}
