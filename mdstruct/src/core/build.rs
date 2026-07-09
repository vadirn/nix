//! Walk comrak's AST into a [`Document`]: separate frontmatter / headings /
//! non-heading blocks at the top level, synthesize the heading tree +
//! `sectionSpan` (comrak gap #3), decompose wikilinks (gap #4), flag `![[…]]`
//! embeds via a pre-pass (Decision 16), and scan opt-in regions (Decision 12).

use comrak::nodes::{AstNode, ListType, NodeValue};
use comrak::{Arena, parse_document};
use sha2::{Digest, Sha256};

use super::model::*;
use super::region;
use super::span::LineIndex;
use super::wikilink;

/// Parse options mirrored onto comrak (Decision 13: wikilinks default on).
pub struct Options {
    pub wikilinks: bool,
    pub regions: Vec<String>,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            wikilinks: true,
            regions: Vec::new(),
        }
    }
}

fn comrak_options(opts: &Options) -> comrak::Options<'static> {
    let mut o = comrak::Options::default();
    o.extension.table = true;
    o.extension.strikethrough = true;
    o.extension.tasklist = true;
    // Footnotes OFF: comrak silently DROPS unreferenced footnote definitions,
    // and the vault's citation style is footnote-definitions-as-bibliography
    // (no inline `[^x]`). On, this breaks total tiling (dropped def's bytes go
    // uncovered) and vanishes distill's citations. Off, they parse as
    // paragraphs — tiled, content preserved — and footnote harvesting stays a
    // distill-side regex lane, like pseudo-tables and enum-marker lists.
    o.extension.autolink = true;
    o.extension.front_matter_delimiter = Some("---".to_string());
    if opts.wikilinks {
        o.extension.wikilinks_title_after_pipe = true;
    }
    o
}

fn sha256_hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let digest = Sha256::digest(bytes);
    let mut s = String::with_capacity(64);
    for b in digest {
        write!(s, "{b:02x}").unwrap();
    }
    s
}

/// Combined span of a node's direct children (first start → last end), or
/// `None` if none. Used for link text / image alt / wikilink alias regions.
fn children_span<'a>(node: &'a AstNode<'a>, idx: &LineIndex) -> Option<Span> {
    let mut lo = usize::MAX;
    let mut hi = 0usize;
    let mut any = false;
    for c in node.children() {
        let sp = c.data.borrow().sourcepos;
        let s = idx.span_of(sp);
        any = true;
        lo = lo.min(s.start);
        hi = hi.max(s.end);
    }
    if any { Some(Span::new(lo, hi)) } else { None }
}

fn opt_string(s: String) -> Option<String> {
    if s.is_empty() { None } else { Some(s) }
}

/// The DECODED display text of a comrak WikiLink: its child `Text` literals
/// concatenated (comrak un-escapes them, so this is reliable inside a table
/// cell where the raw span is not). Empty when the link has no display child
/// (the empty-pipe `[[X|]]`).
fn wikilink_display<'a>(node: &'a AstNode<'a>) -> String {
    let mut s = String::new();
    for c in node.children() {
        if let NodeValue::Text(t) = &c.data.borrow().value {
            s.push_str(t);
        }
    }
    s
}

pub fn build_document(path: &str, source: &str, opts: &Options) -> Document {
    let idx = LineIndex::new(source);
    let arena = Arena::new();
    let options = comrak_options(opts);
    let root = parse_document(&arena, source, &options);

    let mut frontmatter = FrontMatter {
        present: false,
        format: None,
        delimiter: None,
        span: None,
        start_line: None,
        end_line: None,
        body_start_byte: 0,
        body_start_line: 1,
    };
    let mut flat: Vec<FlatHeading> = Vec::new();
    let mut nodes: Vec<Node> = Vec::new();

    for top in root.children() {
        // Match on `&d.value`, not a NodeValue clone: only small Copy fields are
        // read. No `borrow_mut` in the walk; `children_span`/`convert_node`
        // re-borrow shared, so holding this `Ref` across the arm is sound.
        let d = top.data.borrow();
        let sp = d.sourcepos;
        match &d.value {
            NodeValue::FrontMatter(_) => {
                let span = idx.span_of(sp);
                frontmatter = FrontMatter {
                    present: true,
                    format: Some("yaml".to_string()),
                    delimiter: Some("---".to_string()),
                    span: Some(span),
                    start_line: Some(sp.start.line as u32),
                    end_line: Some(sp.end.line as u32),
                    // Body starts the line after the closing delimiter:
                    // bodyStartByte == line_start(bodyStartLine), slice begins
                    // on content (reverses Decision 22, which pointed at
                    // comrak's block end — the closing delimiter's newline).
                    body_start_byte: idx.line_start(sp.end.line + 1),
                    body_start_line: (sp.end.line + 1) as u32,
                };
            }
            NodeValue::Heading(h) => {
                let span = idx.span_of(sp);
                let text_span = children_span(top, &idx).unwrap_or(Span::new(span.end, span.end));
                flat.push(FlatHeading {
                    level: h.level,
                    setext: h.setext,
                    start_col: sp.start.column,
                    span,
                    text_span,
                    start_line: sp.start.line as u32,
                    end_line: sp.end.line as u32,
                });
            }
            _ => {
                if let Some(n) = convert_node(top, source, &idx) {
                    nodes.push(n);
                }
            }
        }
    }

    let headings = build_heading_tree(&flat, &idx);
    fill_gaps(source, &idx, &frontmatter, &headings, &mut nodes);
    let inlines = collect_inlines(root, source, &idx, opts);
    let regions = region::scan(source, &idx, &opts.regions);

    Document {
        schema_version: SCHEMA_VERSION,
        source: Source {
            path: path.to_string(),
            bytes: source.len(),
            sha256: sha256_hex(source.as_bytes()),
        },
        frontmatter,
        headings,
        nodes,
        inlines,
        regions,
    }
}

struct FlatHeading {
    level: u8,
    setext: bool,
    start_col: usize,
    span: Span,
    text_span: Span,
    start_line: u32,
    end_line: u32,
}

/// Synthesize `sectionSpan` (heading → last byte before the next same-or-higher
/// heading, else EOF) and nest the flat sequence into a tree by level.
fn build_heading_tree(flat: &[FlatHeading], idx: &LineIndex) -> Vec<Heading> {
    build_subtree(flat, 0, flat.len(), idx)
}

fn build_subtree(flat: &[FlatHeading], from: usize, to: usize, idx: &LineIndex) -> Vec<Heading> {
    let mut out = Vec::new();
    let mut i = from;
    while i < to {
        let parent_level = flat[i].level;
        let mut j = i + 1;
        while j < to && flat[j].level > parent_level {
            j += 1;
        }
        // Section runs to the next same-or-higher heading in the WHOLE document
        // (not just this slice), else EOF.
        let mut k = i + 1;
        while k < flat.len() && flat[k].level > parent_level {
            k += 1;
        }
        let (section_end, section_end_line) = if k < flat.len() {
            (flat[k].span.start, flat[k].start_line - 1)
        } else {
            (idx.len(), idx.line_count() as u32)
        };
        let children = build_subtree(flat, i + 1, j, idx);
        out.push(Heading {
            node_type: "heading",
            level: flat[i].level,
            setext: flat[i].setext,
            start_col: flat[i].start_col,
            span: flat[i].span,
            text_span: flat[i].text_span,
            start_line: flat[i].start_line,
            end_line: flat[i].end_line,
            section_span: Span::new(flat[i].span.start, section_end),
            section_end_line,
            children,
        });
        i = j;
    }
    out
}

/// Fill non-whitespace tiling gaps with located nodes. comrak consumes some
/// constructs (link reference definitions) to metadata with no AST node; unfixed,
/// their bytes go uncovered and distill's `[^n]: url` citations vanish. Each
/// blank-line-separated chunk becomes one node: link reference definition or
/// (diagnostic) uncovered content.
fn fill_gaps(
    source: &str,
    idx: &LineIndex,
    fm: &FrontMatter,
    headings: &[Heading],
    nodes: &mut Vec<Node>,
) {
    let mut partition: Vec<Span> = Vec::new();
    if fm.present && let Some(s) = fm.span {
        partition.push(s);
    }
    fn push_heading_spans(hs: &[Heading], out: &mut Vec<Span>) {
        for h in hs {
            out.push(h.span);
            push_heading_spans(&h.children, out);
        }
    }
    push_heading_spans(headings, &mut partition);
    for n in nodes.iter() {
        partition.push(n.span());
    }
    partition.sort_by_key(|s| s.start);

    let len = source.len();
    let mut fills: Vec<Node> = Vec::new();
    let mut cursor = 0usize;
    for s in &partition {
        if s.start > cursor {
            emit_fill(source, idx, cursor, s.start, &mut fills);
        }
        cursor = cursor.max(s.end);
    }
    if cursor < len {
        emit_fill(source, idx, cursor, len, &mut fills);
    }
    if !fills.is_empty() {
        nodes.extend(fills);
        nodes.sort_by_key(|n| n.span().start);
    }
}

fn emit_fill(source: &str, idx: &LineIndex, g0: usize, g1: usize, out: &mut Vec<Node>) {
    let bytes = source.as_bytes();
    let is_ws = |b: u8| b == b' ' || b == b'\t' || b == b'\r' || b == b'\n';
    let mut pos = g0;
    // A leading UTF-8 BOM (U+FEFF = EF BB BF) is ignorable like a blank line:
    // skip it so it stays unowned-in-gap, never an Unknown uncovered node.
    if pos == 0 && bytes.len() >= 3 && &bytes[0..3] == b"\xef\xbb\xbf" {
        pos = 3;
    }
    while pos < g1 {
        while pos < g1 && is_ws(bytes[pos]) {
            pos += 1;
        }
        if pos >= g1 {
            break;
        }
        let chunk_start = pos;
        let mut chunk_end;
        loop {
            match source[pos..g1].find('\n') {
                Some(nl) => {
                    let nl_abs = pos + nl;
                    chunk_end = nl_abs;
                    // Is the next line blank (only whitespace up to EOL/gap end)?
                    let mut q = nl_abs + 1;
                    while q < g1 && (bytes[q] == b' ' || bytes[q] == b'\t' || bytes[q] == b'\r') {
                        q += 1;
                    }
                    if q >= g1 || bytes[q] == b'\n' {
                        pos = nl_abs;
                        break;
                    }
                    pos = nl_abs + 1;
                }
                None => {
                    chunk_end = g1;
                    pos = g1;
                    break;
                }
            }
        }
        while chunk_end > chunk_start && is_ws(bytes[chunk_end - 1]) {
            chunk_end -= 1;
        }
        if chunk_end <= chunk_start {
            continue;
        }
        let span = Span::new(chunk_start, chunk_end);
        let start_line = line_of(idx, chunk_start) as u32;
        let end_line = line_of(idx, chunk_end.saturating_sub(1)) as u32;
        let first_line_end = source[chunk_start..chunk_end]
            .find('\n')
            .map(|i| chunk_start + i)
            .unwrap_or(chunk_end);
        let first_line = source[chunk_start..first_line_end].trim_start();
        if first_line.starts_with('[') && first_line.contains("]:") {
            out.push(Node::LinkReferenceDefinition { span, start_line, end_line });
        } else {
            out.push(Node::Unknown {
                kind: "uncovered".to_string(),
                span,
                start_line,
                end_line,
            });
        }
    }
}

/// Convert one non-heading, non-frontmatter block node. Container nodes recurse
/// into `children[]` (descriptive; excluded from tiling). Headings nested inside
/// a container are out of scope for v1 and skipped.
fn convert_node<'a>(node: &'a AstNode<'a>, source: &str, idx: &LineIndex) -> Option<Node> {
    let (value, sp) = {
        let d = node.data.borrow();
        (d.value.clone(), d.sourcepos)
    };
    let span = idx.span_of(sp);
    let start_line = sp.start.line as u32;
    let end_line = sp.end.line as u32;

    let node = match value {
        NodeValue::Paragraph => Node::Paragraph { span, start_line, end_line },
        NodeValue::CodeBlock(ncb) => {
            let fenced = ncb.fenced;
            let fence_char = if fenced {
                Some(ncb.fence_char as char)
            } else {
                None
            };
            let (info_span, body_span) = code_block_spans(&ncb, sp, span, source, idx);
            Node::CodeBlock {
                fenced,
                fence_char,
                fence_length: ncb.fence_length,
                info: ncb.info.clone(),
                info_span,
                body_span,
                span,
                start_line,
                end_line,
            }
        }
        NodeValue::BlockQuote | NodeValue::MultilineBlockQuote(_) => {
            let children = convert_children(node, source, idx);
            Node::BlockQuote {
                span: expand(span, &children),
                start_line,
                end_line,
                children,
            }
        }
        NodeValue::List(nl) => {
            let ordered = nl.list_type == ListType::Ordered;
            let marker = if ordered {
                match nl.delimiter {
                    comrak::nodes::ListDelimType::Period => ".".to_string(),
                    comrak::nodes::ListDelimType::Paren => ")".to_string(),
                }
            } else {
                (nl.bullet_char as char).to_string()
            };
            let children = convert_children(node, source, idx);
            Node::List {
                ordered,
                tight: nl.tight,
                marker,
                start: if ordered { Some(nl.start) } else { None },
                span: expand(span, &children),
                start_line,
                end_line,
                children,
            }
        }
        NodeValue::Item(_) => {
            let children = convert_children(node, source, idx);
            Node::ListItem {
                task: None,
                span: expand(span, &children),
                start_line,
                end_line,
                children,
            }
        }
        NodeValue::TaskItem(ti) => {
            let children = convert_children(node, source, idx);
            Node::ListItem {
                task: Some(ti.symbol.is_some()),
                span: expand(span, &children),
                start_line,
                end_line,
                children,
            }
        }
        NodeValue::Table(_) => {
            let children = convert_children(node, source, idx);
            Node::Table {
                span: expand(span, &children),
                start_line,
                end_line,
                children,
            }
        }
        NodeValue::TableRow(header) => {
            let children = convert_children(node, source, idx);
            Node::TableRow {
                header,
                span: expand(span, &children),
                start_line,
                end_line,
                children,
            }
        }
        NodeValue::TableCell => Node::TableCell { span, start_line, end_line },
        NodeValue::ThematicBreak => Node::ThematicBreak { span, start_line, end_line },
        NodeValue::HtmlBlock(_) => Node::HtmlBlock { span, start_line, end_line },
        NodeValue::FootnoteDefinition(nfd) => {
            let children = convert_children(node, source, idx);
            Node::FootnoteDefinition {
                label: nfd.name.clone(),
                span: expand(span, &children),
                start_line,
                end_line,
                children,
            }
        }
        // A heading nested in a container: out of scope for v1's headings tree.
        NodeValue::Heading(_) => return None,
        other => Node::Unknown {
            kind: format!("{other:?}")
                .split(|c: char| c == '(' || c.is_whitespace())
                .next()
                .unwrap_or("unknown")
                .to_string(),
            span,
            start_line,
            end_line,
        },
    };
    Some(node)
}

fn convert_children<'a>(node: &'a AstNode<'a>, source: &str, idx: &LineIndex) -> Vec<Node> {
    node.children()
        .filter_map(|c| convert_node(c, source, idx))
        .collect()
}

/// A container's tiled span must cover its children. comrak occasionally
/// underreports the extent (e.g. a loose nested list after a blank line), so
/// union comrak's span with every child's.
fn expand(base: Span, children: &[Node]) -> Span {
    let mut s = base;
    for c in children {
        let cs = c.span();
        s.start = s.start.min(cs.start);
        s.end = s.end.max(cs.end);
    }
    s
}

/// `info_span` (verbatim info string on the opening fence line) and `body_span`
/// (RAW inner body — never comrak's dedented `literal`).
fn code_block_spans(
    ncb: &comrak::nodes::NodeCodeBlock,
    sp: comrak::nodes::Sourcepos,
    block: Span,
    source: &str,
    idx: &LineIndex,
) -> (Option<Span>, Span) {
    if !ncb.fenced {
        return (None, block);
    }
    let open_line = sp.start.line;
    let open_line_start = idx.line_start(open_line);
    let fence_end = open_line_start + (sp.start.column - 1) + ncb.fence_length;

    // Slice the raw opening fence line, never decoded `ncb.info`: its `.find`
    // misses on HTML entities/escapes and mis-locates on repeated info text.
    // From `fence_end`, skip leading spaces/tabs, take to the trimmed line end.
    let info_span = {
        let open_line_end = idx.next_line_start(open_line);
        let line = source.get(fence_end..open_line_end).unwrap_or("");
        let lead = line.len() - line.trim_start_matches([' ', '\t']).len();
        let info_start = fence_end + lead;
        let info_end = fence_end + line.trim_end().len();
        if info_end > info_start {
            Some(Span::new(info_start, info_end))
        } else {
            None
        }
    };

    let body_start = idx.line_start(open_line + 1).min(block.end);
    let body_end = if ncb.closed && sp.end.line > open_line {
        // Closed fence: body ends before the closing-fence line. Step back over
        // the terminator CR-aware (`\n`, then a preceding `\r`) so a carriage
        // return does not leak into the body on CRLF files.
        let bytes = source.as_bytes();
        let mut e = idx.line_start(sp.end.line);
        if e > body_start && bytes[e - 1] == b'\n' {
            e -= 1;
        }
        if e > body_start && bytes[e - 1] == b'\r' {
            e -= 1;
        }
        e.max(body_start)
    } else {
        block.end
    };
    let body_span = Span::new(body_start, body_end.max(body_start).min(block.end));
    (info_span, body_span)
}

/// Flat inline collection over the whole tree, plus the `![[…]]` embed pre-pass.
fn collect_inlines<'a>(
    root: &'a AstNode<'a>,
    source: &str,
    idx: &LineIndex,
    opts: &Options,
) -> Vec<Inline> {
    let mut inlines: Vec<Inline> = Vec::new();
    // Code-suppression mask (vault-query src/wikilink.rs:83): spans whose bytes
    // are verbatim, not markup — code (inline + block), frontmatter, raw-HTML
    // blocks (including HTML comments). The `![[…]]` embed pre-pass skips any
    // embed whose `!` falls inside one. GFM tables are NOT masked (1.1): a
    // `![[…]]` in a table cell is now a live embed, and an inline-code cell is
    // still masked by the `Code` span itself, so the pre-pass stays free of
    // phantom embeds without a whole-table mask.
    let mut mask: Vec<Span> = Vec::new();

    for node in root.descendants() {
        // Match on `&d.value`, not a NodeValue clone; clone only the small owned
        // fields (url/title/name) in arms that keep them. No `borrow_mut` in the
        // loop; `in_table`/`children_span` re-borrow shared, so holding this
        // `Ref` across the arm is sound.
        let d = node.data.borrow();
        let sp = d.sourcepos;
        if let NodeValue::Code(_)
        | NodeValue::CodeBlock(_)
        | NodeValue::FrontMatter(_)
        | NodeValue::HtmlBlock(_) = &d.value
        {
            mask.push(idx.span_of(sp));
        }
        // GFM table cells: comrak's inline sourcepos there is unreliable
        // (escaped-pipe cells shift offsets — R2). Non-wikilink inlines
        // (links, code spans, images, footnote refs) stay suppressed inside
        // cells (Decision 19; distill re-slices raw cell bytes). Wikilinks and
        // embeds ARE emitted (1.1): the consumer reads their decoded
        // `target`/`alias`, not the imprecise span, so table-cell backlinks are
        // not lost. The oracle exempts these cell wikilinks (verify.rs).
        if in_table(node) && !matches!(&d.value, NodeValue::WikiLink(_)) {
            continue;
        }
        let span = idx.span_of(sp);
        let start_line = sp.start.line as u32;
        let slice = source.get(span.start..span.end).unwrap_or("");
        match &d.value {
            NodeValue::Link(nl) => {
                if slice.starts_with('[') {
                    let text_span = children_span(node, idx)
                        .unwrap_or(Span::new(span.start, span.start));
                    inlines.push(Inline::Link {
                        url: nl.url.clone(),
                        title: opt_string(nl.title.clone()),
                        text_span,
                        span,
                        start_line,
                    });
                } else {
                    // Angle (`<url>`) or bare GFM autolink.
                    inlines.push(Inline::Autolink {
                        url: nl.url.clone(),
                        span,
                        start_line,
                    });
                }
            }
            NodeValue::Image(nl) => {
                let alt_span =
                    children_span(node, idx).unwrap_or(Span::new(span.start, span.start));
                inlines.push(Inline::Image {
                    url: nl.url.clone(),
                    title: opt_string(nl.title.clone()),
                    alt_span,
                    span,
                    start_line,
                });
            }
            NodeValue::WikiLink(nw) => {
                let t = wikilink::decompose(&nw.url);
                let alias_span = children_span(node, idx);
                // A pipe separates target from alias. comrak drops multi-pipe
                // links (no node), so an emitted wikilink has 0 or 1 pipe: a
                // `|` byte anywhere in the (start-anchored) slice IS the
                // separator. The alias itself is the DECODED display child
                // (`""` for the empty-pipe `[[X|]]`), reliable where a cell
                // span slice is not.
                let alias = if slice.contains('|') {
                    Some(wikilink_display(node))
                } else {
                    None
                };
                inlines.push(Inline::Wikilink {
                    target: nw.url.clone(),
                    page: t.page,
                    heading: t.heading,
                    block: t.block,
                    alias,
                    alias_span,
                    embed: false,
                    span,
                    start_line,
                });
            }
            NodeValue::Code(_) => {
                inlines.push(Inline::CodeSpan { span, start_line });
            }
            NodeValue::FootnoteReference(nfr) => {
                inlines.push(Inline::FootnoteRef {
                    label: nfr.name.clone(),
                    span,
                    start_line,
                });
            }
            _ => {}
        }
    }

    if opts.wikilinks {
        collect_embeds(source, idx, &mask, &mut inlines);
    }

    inlines.sort_by_key(|i| i.span().start);
    inlines
}

/// The `![[…]]` embed pre-pass: comrak emits no WikiLink for embeds, so scan the
/// raw source. `embed = true`; the target decomposes like a normal wikilink.
///
/// Context discipline: Obsidian embeds are single-line, so the closing `]]` is
/// sought only within the `!`'s own line; skip an embed whose `!` sits inside a
/// `mask` span (code / frontmatter) or is backslash-escaped; an inner range that
/// reopens with `[[` is an unclosed embed whose `]]` belongs to a nested
/// wikilink — skip it too (the nested `[[Real]]` is comrak's).
fn collect_embeds(source: &str, idx: &LineIndex, mask: &[Span], inlines: &mut Vec<Inline>) {
    let bytes = source.as_bytes();
    let masked = |off: usize| mask.iter().any(|s| off >= s.start && off < s.end);
    let mut i = 0;
    // `i + 3 <= len` so a trailing `![[x]]` flush against EOF is not missed.
    while i + 3 <= bytes.len() {
        if &bytes[i..i + 3] == b"![[" {
            // An ODD backslash run before `!` escapes it; an even count (e.g.
            // `\\![[…]]` = literal `\` + live `!`) leaves a genuine embed —
            // count the run's parity, not one byte.
            let mut bs = 0usize;
            while i > bs && bytes[i - 1 - bs] == b'\\' {
                bs += 1;
            }
            if bs % 2 == 1 {
                i += 1;
                continue;
            }
            if masked(i) {
                i += 1;
                continue;
            }
            let line = line_of(idx, i);
            let search_end = idx.next_line_start(line).min(bytes.len());
            if let Some(rel_end) = source[i + 3..search_end].find("]]") {
                let inner_end = i + 3 + rel_end;
                let inner = &source[i + 3..inner_end];
                // A nested `[[` before the `]]` means this embed is unclosed and
                // the `]]` closes a nested wikilink; leave it to comrak.
                if inner.contains("[[") {
                    i += 1;
                    continue;
                }
                let end = inner_end + 2;
                // Split on the FIRST pipe: target before, alias after (mirrors
                // vault-query's regex — the alias keeps any later pipes, and an
                // empty-pipe `![[X|]]` yields `Some("")`). The embed span is a
                // byte-exact literal scan, so this raw split is reliable.
                let (target, alias) = match inner.split_once('|') {
                    Some((tgt, ali)) => (tgt, Some(ali.to_string())),
                    None => (inner, None),
                };
                let t = wikilink::decompose(target);
                inlines.push(Inline::Wikilink {
                    target: target.to_string(),
                    page: t.page,
                    heading: t.heading,
                    block: t.block,
                    alias,
                    alias_span: None,
                    embed: true,
                    span: Span::new(i, end),
                    start_line: line as u32,
                });
                i = end;
                continue;
            }
        }
        i += 1;
    }
}

fn in_table<'a>(node: &'a AstNode<'a>) -> bool {
    let mut cur = node.parent();
    while let Some(p) = cur {
        if matches!(
            p.data.borrow().value,
            NodeValue::TableCell | NodeValue::TableRow(_) | NodeValue::Table(_)
        ) {
            return true;
        }
        cur = p.parent();
    }
    false
}

/// 1-based line containing byte offset `pos`.
fn line_of(idx: &LineIndex, pos: usize) -> usize {
    let mut lo = 1usize;
    let mut hi = idx.line_count();
    while lo < hi {
        let mid = (lo + hi).div_ceil(2);
        if idx.line_start(mid) <= pos {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    lo
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build(src: &str) -> Document {
        build_document("t.md", src, &Options::default())
    }

    fn has_wikilink(d: &Document) -> bool {
        d.inlines.iter().any(|i| matches!(i, Inline::Wikilink { .. }))
    }

    // --- A: embed scanner is context-blind ---------------------------------

    #[test]
    fn embed_in_fenced_code_emits_no_wikilink() {
        let d = build("```\n![[Note]]\n```\n");
        assert!(!has_wikilink(&d), "embed inside a fenced code block is verbatim");
    }

    #[test]
    fn embed_in_inline_code_emits_no_wikilink() {
        let d = build("text `![[Note]]` more\n");
        assert!(!has_wikilink(&d), "embed inside an inline code span is verbatim");
    }

    #[test]
    fn embed_in_frontmatter_emits_no_wikilink() {
        let d = build("---\nx: ![[Note]]\n---\n\nbody\n");
        assert!(!has_wikilink(&d), "embed inside frontmatter is verbatim");
    }

    #[test]
    fn embed_in_html_comment_emits_no_wikilink() {
        let d = build("<!-- ![[Note]] -->\n");
        assert!(!has_wikilink(&d), "embed inside an HTML comment is verbatim");
    }

    #[test]
    fn embed_in_table_cell_is_emitted() {
        // 1.1: a table-cell embed is a live backlink, not verbatim. The pre-pass
        // scans it (GFM tables are no longer masked) with a byte-exact span.
        let d = build("| a | b |\n| --- | --- |\n| ![[Note]] | c |\n");
        assert!(
            d.inlines.iter().any(|i| matches!(
                i,
                Inline::Wikilink { page, embed: true, .. } if page == "Note"
            )),
            "embed inside a GFM table cell is emitted as a wikilink",
        );
    }

    #[test]
    fn wikilink_in_table_cell_is_emitted() {
        // 1.1: comrak emits the WikiLink inside the cell; the `in_table` guard
        // no longer suppresses it. `target` comes from the decoded url.
        let d = build("| a | b |\n| --- | --- |\n| [[Note]] | c |\n");
        assert!(
            d.inlines.iter().any(|i| matches!(
                i,
                Inline::Wikilink { target, embed: false, .. } if target == "Note"
            )),
            "plain wikilink inside a GFM table cell is emitted",
        );
    }

    #[test]
    fn table_cell_wikilink_alias_from_escaped_pipe() {
        // `[[a\|b]]` in a cell: comrak sees the escaped pipe as the separator
        // (url="a", display="b"). The span shifts (drops the final `]`), so the
        // consumer must read `target`/`alias`, not the span.
        let d = build("| x |\n| --- |\n| [[a\\|b]] |\n");
        let wl = d
            .inlines
            .iter()
            .find_map(|i| match i {
                Inline::Wikilink { target, alias, .. } => Some((target.clone(), alias.clone())),
                _ => None,
            })
            .expect("table-cell wikilink emitted");
        assert_eq!(wl, ("a".to_string(), Some("b".to_string())));
    }

    #[test]
    fn empty_pipe_alias_is_some_empty() {
        // `[[X|]]`: pipe present, empty display. comrak emits no display child;
        // the pipe in the slice drives `alias = Some("")`, distinct from a
        // no-pipe `[[X]]` (`alias = None`).
        let d = build("[[X|]] and [[X]]\n");
        let aliases: Vec<Option<String>> = d
            .inlines
            .iter()
            .filter_map(|i| match i {
                Inline::Wikilink { alias, .. } => Some(alias.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(aliases, vec![Some(String::new()), None]);
    }

    #[test]
    fn unclosed_embed_yields_no_phantom() {
        // The `]]` closes a NESTED `[[Real]]`, not the `![[`: the embed is
        // unclosed and the scanner must fabricate nothing. (comrak also drops
        // the nested wikilink here — an earlier unclosed `[[` on the line
        // defeats its parser — so no inline survives at all.)
        let d = build("x ![[unclosed [[Real]] y\n");
        assert!(
            !d.inlines.iter().any(|i| matches!(i, Inline::Wikilink { embed: true, .. })),
            "no phantom embed from the unclosed ![[",
        );
    }

    #[test]
    fn embed_prepass_keeps_genuine_adjacent_wikilink() {
        let d = build("![[Note]] and [[Real]]\n");
        assert!(
            d.inlines.iter().any(|i| matches!(
                i,
                Inline::Wikilink { page, embed: true, .. } if page == "Note"
            )),
            "the embed is recovered",
        );
        assert!(
            d.inlines.iter().any(|i| matches!(
                i,
                Inline::Wikilink { page, embed: false, .. } if page == "Real"
            )),
            "the genuine [[Real]] wikilink survives the pre-pass",
        );
    }

    #[test]
    fn embed_flush_against_eof_is_found() {
        let d = build("![[X]]");
        assert!(
            d.inlines
                .iter()
                .any(|i| matches!(i, Inline::Wikilink { page, embed: true, .. } if page == "X")),
            "a trailing ![[X]] at EOF is not missed",
        );
    }

    // --- C: info span slices the raw fence line ----------------------------

    #[test]
    fn info_span_slices_raw_with_entities() {
        let src = "```a&amp;b\ncode\n```\n";
        let d = build(src);
        let cb = d.nodes.iter().find(|n| matches!(n, Node::CodeBlock { .. })).unwrap();
        if let Node::CodeBlock { info, info_span, .. } = cb {
            assert_eq!(info, "a&b", "comrak decodes the info string");
            let sp = info_span.expect("info span present");
            assert_eq!(&src[sp.start..sp.end], "a&amp;b", "span slices the RAW info");
        }
    }

    // --- D: CRLF body excludes the full CRLF -------------------------------

    #[test]
    fn crlf_body_excludes_carriage_return() {
        let src = "```\r\nbody\r\n```\r\n";
        let d = build(src);
        let cb = d.nodes.iter().find(|n| matches!(n, Node::CodeBlock { .. })).unwrap();
        if let Node::CodeBlock { body_span, .. } = cb {
            assert_eq!(&src[body_span.start..body_span.end], "body");
        }
    }

    // --- E: frontmatter body starts on content -----------------------------

    #[test]
    fn frontmatter_body_start_byte_is_line_start() {
        let src = "---\ntitle: x\n---\nbody\n";
        let d = build(src);
        let fm = d.frontmatter().expect("frontmatter present");
        let idx = LineIndex::new(src);
        assert_eq!(fm.body_start_byte, idx.line_start(fm.body_start_line as usize));
        assert!(src[fm.body_start_byte..].starts_with("body"));
    }
}
