//! Locator facet over [`mdstruct`]: the body's headings in document order, plus
//! line splitting and a wikilink count — everything the reader's tree builder
//! consumes, from one whole-document parse.
//!
//! comrak already excludes a `#` inside a code fence or the frontmatter block,
//! so no fence-toggling scan is needed for heading detection.

use mdstruct::{Heading, Options, parse};

/// Which headings count as section openers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeadingRule {
    /// CommonMark: every ATX/setext heading with non-empty text, including the
    /// 0–3-space indents CommonMark allows. The general reader's default.
    CommonMark,
    /// Vault-strict: column-1, non-setext ATX headings only. Reproduces
    /// vault-query's historical `read` behavior (its `markdown.rs` scanner
    /// rejected any leading whitespace).
    StrictColumn1,
}

/// A body heading located by mdstruct, filtered to the active [`HeadingRule`].
pub struct BodyHeading {
    pub level: usize,
    /// 1-based line of the heading.
    pub line: usize,
    /// Post-`#` heading text, trimmed. comrak strips a `## x ##` closing-hash run.
    pub text: String,
}

/// The body's headings in document order under `rule`.
pub fn body_headings(content: &str, rule: HeadingRule) -> Vec<BodyHeading> {
    let opts = Options { wikilinks: false };
    let doc = parse(content, &opts);
    let mut out = Vec::new();
    collect_headings(doc.headings(), content, rule, &mut out);
    out
}

/// Number of wikilinks in the body — the overview's `links:` count. Read from
/// mdstruct inlines (a `[[…]]` inside a code fence is already excluded).
pub fn link_count(content: &str) -> usize {
    let opts = Options { wikilinks: true };
    let doc = parse(content, &opts);
    doc.inlines()
        .iter()
        .filter(|i| matches!(i, mdstruct::Inline::Wikilink { .. }))
        .count()
}

/// Pre-order flatten (document order) of the heading tree, keeping the headings
/// the active rule admits.
fn collect_headings(hs: &[Heading], content: &str, rule: HeadingRule, out: &mut Vec<BodyHeading>) {
    for h in hs {
        // `.get(..).unwrap_or("")` not indexing: a malformed span degrades to
        // empty rather than panicking the reader.
        let text = content
            .get(h.text_span.start..h.text_span.end)
            .unwrap_or("")
            .trim();
        let admit = match rule {
            HeadingRule::StrictColumn1 => h.start_col == 1 && !h.setext && !text.is_empty(),
            HeadingRule::CommonMark => !text.is_empty(),
        };
        if admit {
            out.push(BodyHeading {
                level: h.level as usize,
                line: h.start_line as usize,
                text: text.to_string(),
            });
        }
        collect_headings(&h.children, content, rule, out);
    }
}

/// Split `content` on CommonMark line endings — `\n`, `\r\n`, and a lone `\r` —
/// so consumer line numbering matches comrak/mdstruct. Agrees with [`str::lines`]
/// on pure-LF and CRLF input, and additionally breaks on a lone `\r`.
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
    use super::*;

    #[test]
    fn lines_breaks_on_lone_cr() {
        assert_eq!(lines("a\rb\rc"), vec!["a", "b", "c"]);
        assert_eq!(lines("a\rb\r"), vec!["a", "b"]);
    }

    #[test]
    fn lines_agrees_with_str_lines_on_lf_and_crlf() {
        for s in ["", "a", "a\nb", "a\nb\n", "a\r\nb", "a\r\nb\r\n"] {
            assert_eq!(lines(s), s.lines().collect::<Vec<_>>(), "input {s:?}");
        }
    }

    #[test]
    fn strict_rejects_indented_heading_commonmark_admits() {
        let c = "# A\n\n  ## Indented\n";
        // Strict: only the column-1 `# A`.
        let strict = body_headings(c, HeadingRule::StrictColumn1);
        assert_eq!(strict.len(), 1);
        assert_eq!(strict[0].text, "A");
        // CommonMark: both (0–3-space indent is a valid heading).
        let cm = body_headings(c, HeadingRule::CommonMark);
        assert_eq!(cm.len(), 2);
        assert_eq!(cm[1].text, "Indented");
    }

    #[test]
    fn fenced_hash_is_not_a_heading() {
        let c = "# Real\n\n```\n# not a heading\n```\n";
        assert_eq!(body_headings(c, HeadingRule::CommonMark).len(), 1);
    }
}
