//! Locator facet over [`mdstruct`]: the structural primitives the vault-body
//! walkers need, derived from one whole-document parse instead of per-line
//! scanning. Replaces the hand-rolled `markdown.rs` scanner (mdstruct-plan §4 step 3).
//!
//! [`Facet::headings`] reproduces `markdown::atx_heading`'s rule as a filter over
//! mdstruct's heading tree: an ATX heading starts at column 1 (`start_col == 1`,
//! rejecting the 1–3 space indents CommonMark allows but the scanner rejected), is
//! not setext, and has non-empty post-`#` text. comrak already excludes a `#`
//! inside a code fence or the frontmatter block, so the fence-toggling first pass
//! the callers ran is no longer needed for heading detection.
//!
//! [`Facet::fenced_lines`] reproduces the fence toggler's skip set: the 1-based
//! lines covered by every code block, fenced OR indented. The old `markdown.rs`
//! toggler ran `fence_marker` on the left-trimmed line, so it masked indented
//! fences too; masking every `CodeBlock` keeps code content — an indented block is
//! comrak's `CodeBlock { fenced: false }` — out of the relation and glossary
//! scanners, which must never parse code as edges or terms.

use std::collections::BTreeSet;

use mdstruct::{Heading, Node, Options, parse};

/// A body ATX heading located by mdstruct, filtered to the scanner's rule.
pub struct BodyHeading {
    pub level: usize,
    /// 1-based line of the heading.
    pub line: usize,
    /// Post-`#` heading text, trimmed, sliced from `text_span`. comrak strips a
    /// `## x ##` closing-hash run the old scanner kept — this is the canonical text.
    pub text: String,
}

/// Both structural primitives from a single parse: the body's ATX headings in
/// document order and the set of lines inside code blocks.
pub struct Facet {
    pub headings: Vec<BodyHeading>,
    /// 1-based lines covered by every code block, fenced OR indented. Named
    /// `fenced_lines` for its call sites, but it masks indented code too so no
    /// scanner parses code content as a relation edge or glossary term.
    pub fenced_lines: BTreeSet<usize>,
}

/// Parse `content` once and derive the locator facet.
pub fn facet(content: &str) -> Facet {
    let opts = Options {
        wikilinks: false,
        regions: Vec::new(),
    };
    let doc = parse(content, &opts);
    let mut headings = Vec::new();
    collect_headings(doc.headings(), content, &mut headings);
    let mut fenced_lines = BTreeSet::new();
    collect_fenced(doc.nodes(), &mut fenced_lines);
    Facet {
        headings,
        fenced_lines,
    }
}

/// The body's ATX headings in document order — a thin wrapper over [`facet`] for
/// callers (`read`, `section`) that need only the heading list.
pub fn body_headings(content: &str) -> Vec<BodyHeading> {
    facet(content).headings
}

/// Pre-order flatten (document order) of the heading tree, keeping only the
/// column-1, non-setext, non-empty ATX headings the old scanner detected.
fn collect_headings(hs: &[Heading], content: &str, out: &mut Vec<BodyHeading>) {
    for h in hs {
        // `.get(..).unwrap_or("")` not indexing: this path never runs mdstruct
        // `verify_spans`, so a malformed span degrades to empty instead of
        // panicking the whole vault-query command.
        let text = content
            .get(h.text_span.start..h.text_span.end)
            .unwrap_or("")
            .trim();
        if h.start_col == 1 && !h.setext && !text.is_empty() {
            out.push(BodyHeading {
                level: h.level as usize,
                line: h.start_line as usize,
                text: text.to_string(),
            });
        }
        collect_headings(&h.children, content, out);
    }
}

/// Union of the 1-based line ranges of every code block — fenced OR indented —
/// recursing through [`Node::children`] so a code block nested in a
/// blockquote/list still masks its lines. An indented block is comrak's
/// `CodeBlock { fenced: false }`; its interior must never reach the
/// relation/glossary scanners, so both kinds contribute their lines.
fn collect_fenced(nodes: &[Node], lines: &mut BTreeSet<usize>) {
    for n in nodes {
        if let Node::CodeBlock {
            start_line,
            end_line,
            ..
        } = n
        {
            for l in (*start_line as usize)..=(*end_line as usize) {
                lines.insert(l);
            }
        }
        collect_fenced(n.children(), lines);
    }
}

/// Split `content` on CommonMark line endings — `\n`, `\r\n`, and a lone `\r` —
/// so consumer line numbering matches comrak/mdstruct. Agrees with
/// [`str::lines`] on pure-LF and CRLF input (no trailing empty line when the
/// document ends with a terminator) and additionally breaks on a lone `\r`,
/// which `str::lines` does not treat as a boundary. The delimiters are ASCII, so
/// every slice lands on a UTF-8 boundary.
pub fn lines(content: &str) -> Vec<&str> {
    let bytes = content.as_bytes();
    let mut out = Vec::new();
    let mut start = 0;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\n' => {
                out.push(&content[start..i]);
                i += 1;
                start = i;
            }
            b'\r' => {
                out.push(&content[start..i]);
                i += 1;
                if i < bytes.len() && bytes[i] == b'\n' {
                    i += 1;
                }
                start = i;
            }
            _ => i += 1,
        }
    }
    if start < bytes.len() {
        out.push(&content[start..]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::lines;

    #[test]
    fn lines_breaks_on_lone_cr() {
        assert_eq!(lines("a\rb\rc"), vec!["a", "b", "c"]);
        // Trailing lone `\r` closes the last line without a phantom empty one.
        assert_eq!(lines("a\rb\r"), vec!["a", "b"]);
    }

    #[test]
    fn lines_agrees_with_str_lines_on_lf_and_crlf() {
        for s in ["", "a", "a\nb", "a\nb\n", "a\r\nb", "a\r\nb\r\n"] {
            assert_eq!(lines(s), s.lines().collect::<Vec<_>>(), "input {s:?}");
        }
    }
}
