//! The intrinsic, consumer-neutral freeze gate (Decision 11/15/17):
//!
//! 1. **Total tiling** — the structural partition (frontmatter + every heading +
//!    every top-level node) is disjoint and non-overlapping, and every inter-span
//!    gap (plus the leading/trailing remainder) is inter-block whitespace that
//!    the check reproduces, so spans + gaps = source byte-for-byte.
//! 2. **Per-inline grammar oracle** — each inline's slice matches its type's
//!    delimiter shape, and each sub-span nests within its outer span.
//! 3. **Node interior nesting** — `codeBlock` `infoSpan`/`bodySpan` nest.
//! 4. **Region-slice check** — when labels are registered, each region's span
//!    and body_span slice and nest.
//!
//! Intrinsic: `verify_spans(doc, source)` takes no consumer policy and no golden
//! reference, so it belongs in the freeze gate.

use super::model::*;

#[derive(Debug, Clone)]
pub struct SpanMismatch {
    pub message: String,
}

impl std::fmt::Display for SpanMismatch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for SpanMismatch {}

fn err(message: String) -> SpanMismatch {
    SpanMismatch { message }
}

fn is_ws(s: &str) -> bool {
    s.chars().all(|c| c == ' ' || c == '\t' || c == '\r' || c == '\n')
}

fn slice(source: &str, span: Span) -> Result<&str, SpanMismatch> {
    source.get(span.start..span.end).ok_or_else(|| {
        err(format!(
            "span [{}, {}) does not slice source (len {}) on a char boundary",
            span.start,
            span.end,
            source.len()
        ))
    })
}

fn nests(outer: Span, inner: Span) -> bool {
    outer.start <= inner.start && inner.end <= outer.end
}

/// Run the whole freeze gate over one parsed document.
pub fn verify_spans(doc: &Document, source: &str) -> Result<(), SpanMismatch> {
    verify_tiling(doc, source)?;
    verify_inlines(doc, source)?;
    verify_nodes(&doc.nodes, source)?;
    verify_no_unknown(&doc.nodes)?;
    if !doc.regions.is_empty() {
        verify_regions(doc, source)?;
    }
    Ok(())
}

/// A clean freeze has zero `Node::Unknown`: any Unknown (gap-filler "uncovered"
/// fill or untyped comrak block) is a coverage hole the schema does not yet
/// name. Recurses into container children.
fn verify_no_unknown(nodes: &[Node]) -> Result<(), SpanMismatch> {
    for n in nodes {
        if let Node::Unknown { kind, span, .. } = n {
            return Err(err(format!(
                "untyped node (kind {:?}) at [{}, {}): a block the schema does not cover",
                kind, span.start, span.end
            )));
        }
        verify_no_unknown(n.children())?;
    }
    Ok(())
}

/// Whitespace-gap total tiling (Decision 15).
fn verify_tiling(doc: &Document, source: &str) -> Result<(), SpanMismatch> {
    let mut spans: Vec<Span> = Vec::new();
    if let Some(fm) = doc.frontmatter()
        && let Some(s) = fm.span
    {
        spans.push(s);
    }
    flatten_headings(&doc.headings, &mut spans);
    for n in &doc.nodes {
        spans.push(n.span());
    }
    spans.sort_by_key(|s| s.start);

    let len = source.len();
    let mut cursor = 0usize;
    for s in &spans {
        if s.start < cursor {
            return Err(err(format!(
                "overlap: span [{}, {}) starts before cursor {} (a preceding span ran long, or a multibyte overshoot)",
                s.start, s.end, cursor
            )));
        }
        let gap = source.get(cursor..s.start).ok_or_else(|| {
            err(format!("gap [{}, {}) is not a valid slice", cursor, s.start))
        })?;
        // Tolerate a leading UTF-8 BOM (U+FEFF) like a blank line: strip it
        // before the whitespace check.
        let gap = if cursor == 0 {
            gap.strip_prefix('\u{feff}').unwrap_or(gap)
        } else {
            gap
        };
        if !is_ws(gap) {
            return Err(err(format!(
                "non-whitespace gap [{}, {}): {:?} — a span falls short of real content",
                cursor,
                s.start,
                gap.chars().take(40).collect::<String>()
            )));
        }
        slice(source, *s)?;
        cursor = s.end;
    }
    let tail = source.get(cursor..len).ok_or_else(|| {
        err(format!("trailing region [{}, {}) is not a valid slice", cursor, len))
    })?;
    // Same leading-BOM tolerance: with no tiled span (cursor == 0) the BOM
    // still leads the tail, so a BOM-only file passes like its whitespace-only twin.
    let tail = if cursor == 0 {
        tail.strip_prefix('\u{feff}').unwrap_or(tail)
    } else {
        tail
    };
    if !is_ws(tail) {
        return Err(err(format!(
            "non-whitespace trailing region [{}, {}): {:?}",
            cursor,
            len,
            tail.chars().take(40).collect::<String>()
        )));
    }
    Ok(())
}

fn flatten_headings(hs: &[Heading], out: &mut Vec<Span>) {
    for h in hs {
        out.push(h.span);
        flatten_headings(&h.children, out);
    }
}

/// Collect every `tableCell` span (recursing Table → TableRow → TableCell), so
/// the inline oracle can locate a wikilink that lives inside a cell.
fn collect_table_cell_spans(nodes: &[Node], out: &mut Vec<Span>) {
    for n in nodes {
        if let Node::TableCell { span, .. } = n {
            out.push(*span);
        }
        collect_table_cell_spans(n.children(), out);
    }
}

/// Per-inline grammar oracle + sub-span nesting.
fn verify_inlines(doc: &Document, source: &str) -> Result<(), SpanMismatch> {
    let mut cells: Vec<Span> = Vec::new();
    collect_table_cell_spans(&doc.nodes, &mut cells);
    for inl in &doc.inlines {
        let sp = inl.span();
        let s = slice(source, sp)?;
        // Table-cell wikilinks/embeds (1.1): comrak's inline sourcepos shifts on
        // escaped-pipe cells (Decision 19), so the span is imprecise and fails
        // the `]]` shape check. The consumer reads the decoded `target`/`alias`,
        // not the span, so exempt a wikilink contained in a tableCell from the
        // shape + sub-span-nesting oracle. The boundary slice above still holds
        // (the span is a valid on-char slice), and Decision 19 stays in force
        // for every non-wikilink table-cell inline (those are not emitted).
        if matches!(inl, Inline::Wikilink { .. }) && cells.iter().any(|c| nests(*c, sp)) {
            continue;
        }
        let (ok, sub) = match inl {
            Inline::Link { text_span, .. } => (
                s.starts_with('[') && (s.ends_with(')') || s.ends_with(']')),
                Some(*text_span),
            ),
            Inline::Image { alt_span, .. } => (
                s.starts_with("![") && (s.ends_with(')') || s.ends_with(']')),
                Some(*alt_span),
            ),
            Inline::Wikilink { embed, alias_span, .. } => {
                let core = if *embed {
                    s.strip_prefix('!').unwrap_or(s)
                } else {
                    s
                };
                (core.starts_with("[[") && core.ends_with("]]"), *alias_span)
            }
            Inline::Autolink { .. } => (
                (s.starts_with('<') && s.ends_with('>'))
                    || s.contains("://")
                    || s.contains('@')
                    || s.starts_with("www."),
                None,
            ),
            Inline::CodeSpan { .. } => (s.starts_with('`') && s.ends_with('`'), None),
            Inline::FootnoteRef { .. } => (s.starts_with("[^") && s.ends_with(']'), None),
        };
        if !ok {
            return Err(err(format!(
                "inline {} at [{}, {}) fails its grammar oracle: {:?}",
                inl.kind(),
                sp.start,
                sp.end,
                s.chars().take(60).collect::<String>()
            )));
        }
        if let Some(sub) = sub {
            slice(source, sub)?;
            if !nests(sp, sub) {
                return Err(err(format!(
                    "inline {} sub-span [{}, {}) not nested in outer [{}, {})",
                    inl.kind(),
                    sub.start,
                    sub.end,
                    sp.start,
                    sp.end
                )));
            }
        }
    }
    Ok(())
}

/// Node interior span nesting (codeBlock info/body).
fn verify_nodes(nodes: &[Node], source: &str) -> Result<(), SpanMismatch> {
    for n in nodes {
        if let Node::CodeBlock {
            span,
            info_span,
            body_span,
            ..
        } = n
        {
            if let Some(is) = info_span {
                slice(source, *is)?;
                if !nests(*span, *is) {
                    return Err(err(format!(
                        "codeBlock infoSpan [{}, {}) not nested in [{}, {})",
                        is.start, is.end, span.start, span.end
                    )));
                }
            }
            slice(source, *body_span)?;
            if !nests(*span, *body_span) {
                return Err(err(format!(
                    "codeBlock bodySpan [{}, {}) not nested in [{}, {})",
                    body_span.start, body_span.end, span.start, span.end
                )));
            }
        }
        verify_nodes(n.children(), source)?;
    }
    Ok(())
}

/// Opt-in region-slice check (Decision 17).
fn verify_regions(doc: &Document, source: &str) -> Result<(), SpanMismatch> {
    for r in &doc.regions {
        let whole = slice(source, r.span)?;
        slice(source, r.body_span)?;
        if !nests(r.span, r.body_span) {
            return Err(err(format!(
                "region {} body_span [{}, {}) not nested in span [{}, {})",
                r.label, r.body_span.start, r.body_span.end, r.span.start, r.span.end
            )));
        }
        // Byte-based anchor check holding for both whole-line and inline
        // classes: the span opens on `<!--` and closes on `-->`.
        if !(whole.trim_start().starts_with("<!--") && whole.trim_end().ends_with("-->")) {
            return Err(err(format!(
                "region {} span is not bounded by anchor comments: {:?}",
                r.label, whole
            )));
        }
    }
    Ok(())
}
