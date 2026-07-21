//! The comment-anchor overlay scanner (Decision 12). Always-on and complete:
//! every recognised `<!-- <label>[: <info>] -->` … `<!-- /<label> -->` pair is
//! emitted into `regions[]`; consumers filter by label. A region references a
//! span WITHOUT disturbing structure (the interior is still parsed into
//! `nodes[]`/`headings[]`), may overlap freely, and is excluded from tiling.
//!
//! Recognition is a single raw byte scan for single-line `<!-- … -->` comments
//! over the whole source, masked by fenced-code + indented-code + inline-code
//! spans plus multi-line HTML-comment blocks (comrak is consulted only to build
//! that mask, never to enumerate anchors). Multi-line HTML comments are not
//! anchors (single-line only — pinned convention).
//!
//! Mask reliability. The block-level masks (fenced/indented code, multi-line
//! HTML comment) rest on comrak's block sourcepos, which is exact — an anchor
//! buried in any of them is reliably inert. The inline-code (`NodeValue::Code`)
//! mask instead tracks comrak's INLINE sourcepos, which is not always exact.
//! Its failure mode is one-sided: an imprecise inline-code span can only over-
//! or under-cover an anchor that is ALREADY inside inline code, so it may
//! mis-suppress a real anchor but can never fabricate one from live prose. That
//! blast radius is narrow and the failure is safe (a dropped region, not a
//! phantom), so this is accepted, not hardened. The one multi-line blind spot
//! that WAS a genuine phantom-region source — anchor-looking text on a
//! continuation line of a multi-line HTML comment — is now handled by the
//! multi-line HTML-comment mask (build.rs).
//!
//! Span convention — pinned per endpoint, not per pair (Decision 17):
//!   `span.start`/`body_span.start` follow the OPEN's class;
//!   `span.end`/`body_span.end` follow the CLOSE's class.
//!   - whole-line endpoint (an anchor that is the entire trimmed line): the
//!     line-based convention, byte-identical to the pre-rewrite scanner —
//!     span.start = line_start(open), body start = line_start(open+1);
//!     span.end = next_line_start(close), body end = line_start(close).
//!   - inline endpoint (an anchor embedded in a text run): byte-offset spans —
//!     span.start = open.start_byte, body start = open.end_byte;
//!     span.end = close.end_byte, body end = close.start_byte.
//!
//! `start_line`/`end_line` are the lines the open/close anchor offsets fall on.

use super::model::{Region, Span};
use super::span::LineIndex;

/// One end of an anchor pair recognised inside a single line.
enum Anchor<'a> {
    Open { label: &'a str, info: Option<&'a str> },
    Close { label: &'a str },
}

/// A recognised but unpaired anchor: a leftover open (`unpaired-open`) or a
/// close with no matching open (`unpaired-close`). Never enters NDJSON
/// `regions[]` (`#[serde(skip)]` on `Document`); surfaced only by `check`.
#[derive(Debug, Clone)]
pub struct Dangling {
    /// `"unpaired-open"` or `"unpaired-close"`.
    pub kind: &'static str,
    pub label: String,
    /// The anchor comment's own byte span `[start, end)`.
    pub span: Span,
    /// 1-based line the anchor comment starts on.
    pub line: u32,
}

/// Result of a whole-source scan: paired regions (sorted by `span.start`) and
/// unpaired anchors (sorted by `span.start`).
pub struct ScanResult {
    pub regions: Vec<Region>,
    pub dangling: Vec<Dangling>,
}

/// Parse a comment (`<!-- … -->`) as an anchor (`None` otherwise). The argument
/// is exactly one comment's bytes, prefix/suffix included.
fn parse_anchor(comment: &str) -> Option<Anchor<'_>> {
    let inner = comment
        .trim()
        .strip_prefix("<!--")?
        .strip_suffix("-->")?
        .trim();
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

/// An open awaiting its close. `whole_line` fixes which endpoint convention the
/// open's half of the pair uses; `start_byte`/`end_byte` are the open comment's
/// bounds, `line_no` the 1-based line it starts on.
struct OpenEntry {
    label: String,
    info: Option<String>,
    whole_line: bool,
    line_no: usize,
    start_byte: usize,
    end_byte: usize,
}

/// Scan `source` for `<!-- … -->` anchor comments and pair them per label.
///
/// `mask` holds byte ranges (fenced-code + inline-code spans) whose anchors are
/// inert: a comment whose start byte falls inside any mask span is skipped, so
/// an anchor buried in code neither pairs nor dangles. Pairing is per-label LIFO
/// (each close pops its most recent same-label open) and kind-agnostic, so
/// reused labels nest and distinct labels interleave.
pub fn scan(source: &str, idx: &LineIndex, mask: &[Span]) -> ScanResult {
    let masked = |byte: usize| mask.iter().any(|s| byte >= s.start && byte < s.end);

    let mut open_stack: Vec<OpenEntry> = Vec::new();
    let mut regions: Vec<Region> = Vec::new();
    let mut dangling: Vec<Dangling> = Vec::new();

    for line_no in 1..=idx.line_count() {
        let line_start = idx.line_start(line_no);
        let line_end = idx.next_line_start(line_no);
        let line = &source[line_start..line_end];
        let trimmed = line.trim();

        // Walk the line left-to-right for `<!-- … -->` comments closing on the
        // same line. A `<!--` with no `-->` after it on this line is not a
        // single-line comment, so stop scanning the line.
        let mut from = 0usize;
        while let Some(rel_open) = line[from..].find("<!--") {
            let open_rel = from + rel_open;
            let after = open_rel + 4;
            let Some(rel_close) = line[after..].find("-->") else {
                break;
            };
            let comment_end_rel = after + rel_close + 3;
            let comment = &line[open_rel..comment_end_rel];
            let start_byte = line_start + open_rel;
            let end_byte = line_start + comment_end_rel;
            from = comment_end_rel;

            if masked(start_byte) {
                continue;
            }
            let Some(anchor) = parse_anchor(comment) else {
                continue;
            };
            // Whole-line iff the comment is the entire trimmed line content.
            let whole_line = trimmed == comment;

            match anchor {
                Anchor::Open { label, info } => {
                    open_stack.push(OpenEntry {
                        label: label.to_string(),
                        info: info.map(str::to_string),
                        whole_line,
                        line_no,
                        start_byte,
                        end_byte,
                    });
                }
                Anchor::Close { label } => {
                    match open_stack.iter().rposition(|o| o.label == label) {
                        Some(pos) => {
                            let open = open_stack.remove(pos);
                            let span_start = if open.whole_line {
                                idx.line_start(open.line_no)
                            } else {
                                open.start_byte
                            };
                            let span_end = if whole_line {
                                idx.next_line_start(line_no)
                            } else {
                                end_byte
                            };
                            let body_start = if open.whole_line {
                                idx.line_start(open.line_no + 1)
                            } else {
                                open.end_byte
                            };
                            let body_end = if whole_line {
                                idx.line_start(line_no)
                            } else {
                                start_byte
                            };
                            regions.push(Region {
                                node_type: "region",
                                label: open.label,
                                info: open.info,
                                span: Span::new(span_start, span_end),
                                body_span: Span::new(body_start, body_end),
                                start_line: open.line_no as u32,
                                end_line: line_no as u32,
                            });
                        }
                        None => {
                            dangling.push(Dangling {
                                kind: "unpaired-close",
                                label: label.to_string(),
                                span: Span::new(start_byte, end_byte),
                                line: line_no as u32,
                            });
                        }
                    }
                }
            }
        }
    }

    // Leftover opens never met a close.
    for open in open_stack {
        dangling.push(Dangling {
            kind: "unpaired-open",
            label: open.label,
            span: Span::new(open.start_byte, open.end_byte),
            line: open.line_no as u32,
        });
    }

    regions.sort_by_key(|r| r.span.start);
    dangling.sort_by_key(|d| d.span.start);
    ScanResult { regions, dangling }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scans_one_region() {
        let src = "<!-- workflow: id=build -->\n- [ ] compile\n<!-- /workflow -->\n";
        let idx = LineIndex::new(src);
        let res = scan(src, &idx, &[]);
        assert_eq!(res.regions.len(), 1);
        assert!(res.dangling.is_empty());
        let r = &res.regions[0];
        assert_eq!(r.label, "workflow");
        assert_eq!(r.info.as_deref(), Some("id=build"));
        assert_eq!(r.start_line, 1);
        assert_eq!(r.end_line, 3);
        // Whole-line body is exactly the bytes between the anchor lines.
        assert_eq!(&src[r.body_span.start..r.body_span.end], "- [ ] compile\n");
    }

    #[test]
    fn nested_same_and_different_labels() {
        let src = "<!-- a -->\n<!-- b -->\ninner\n<!-- /b -->\n<!-- /a -->\n";
        let idx = LineIndex::new(src);
        let res = scan(src, &idx, &[]);
        assert_eq!(res.regions.len(), 2);
        assert!(res.dangling.is_empty());
        // Outer `a` sorts first (opens earlier).
        assert_eq!(res.regions[0].label, "a");
        assert_eq!(res.regions[1].label, "b");
    }

    #[test]
    fn inline_anchors_pair_with_byte_spans() {
        let src = "before <!-- hl -->mid<!-- /hl --> after\n";
        let idx = LineIndex::new(src);
        let res = scan(src, &idx, &[]);
        assert_eq!(res.regions.len(), 1);
        assert!(res.dangling.is_empty());
        let r = &res.regions[0];
        assert_eq!(r.label, "hl");
        let open_start = src.find("<!-- hl -->").unwrap();
        let open_end = open_start + "<!-- hl -->".len();
        let close_start = src.find("<!-- /hl -->").unwrap();
        let close_end = close_start + "<!-- /hl -->".len();
        // Inline endpoints are byte offsets, not line boundaries.
        assert_eq!(r.span.start, open_start);
        assert_eq!(r.span.end, close_end);
        assert_eq!(r.body_span.start, open_end);
        assert_eq!(r.body_span.end, close_start);
        assert_eq!(&src[r.body_span.start..r.body_span.end], "mid");
        assert_eq!(r.start_line, 1);
        assert_eq!(r.end_line, 1);
    }

    #[test]
    fn masked_anchor_is_inert() {
        // An inline-code span carrying an anchor-looking comment is masked, so
        // the open never registers and the real close is left unpaired.
        let src = "`<!-- open -->`\nbody\n<!-- /open -->\n";
        let idx = LineIndex::new(src);
        let code = Span::new(idx.line_start(1), idx.next_line_start(1));
        let res = scan(src, &idx, &[code]);
        assert!(res.regions.is_empty());
        assert_eq!(res.dangling.len(), 1);
        assert_eq!(res.dangling[0].kind, "unpaired-close");
        assert_eq!(res.dangling[0].label, "open");
    }

    #[test]
    fn unpaired_open_and_close_are_dangling() {
        let src = "<!-- a -->\nx\n<!-- /b -->\n";
        let idx = LineIndex::new(src);
        let res = scan(src, &idx, &[]);
        assert!(res.regions.is_empty());
        let kinds: Vec<&str> = res.dangling.iter().map(|d| d.kind).collect();
        assert!(kinds.contains(&"unpaired-open"));
        assert!(kinds.contains(&"unpaired-close"));
    }

    // S7: an open outside any fence (line 5), a stray same-label close buried in
    // a fenced code block (lines 7-9), and the real close later (line 11). With
    // the fenced block masked, the in-fence close is inert and the open pairs
    // with the real close on line 11.
    const S7_SRC: &str = "\
alpha
beta
gamma
delta
<!-- interact: foo -->
epsilon
```
<!-- /interact -->
```
zeta
<!-- /interact -->
";

    #[test]
    fn s7_masked_close_pairs_with_real_close() {
        let idx = LineIndex::new(S7_SRC);
        let fence = Span::new(idx.line_start(7), idx.next_line_start(9));
        let res = scan(S7_SRC, &idx, &[fence]);
        assert_eq!(res.regions.len(), 1);
        assert!(res.dangling.is_empty());
        let r = &res.regions[0];
        assert_eq!(r.start_line, 5);
        assert_eq!(r.end_line, 11);
        assert_eq!(r.span.start, idx.line_start(5));
        assert_eq!(r.span.end, idx.next_line_start(11));
    }

    // Q1: a fully-in-fence balanced open/close pair; with the fence masked both
    // anchors are inert and nothing is emitted.
    const Q1_SRC: &str = "\
```
<!-- interact: x -->
<!-- /interact -->
```
";

    #[test]
    fn q1_masked_pair_is_suppressed() {
        let idx = LineIndex::new(Q1_SRC);
        let fence = Span::new(idx.line_start(1), idx.next_line_start(4));
        let res = scan(Q1_SRC, &idx, &[fence]);
        assert!(res.regions.is_empty());
        assert!(res.dangling.is_empty());
    }
}
