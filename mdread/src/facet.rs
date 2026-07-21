//! Locator facet over [`mdstruct`]: the body's headings in document order, its
//! outgoing links, and line splitting — everything the reader's tree builder and
//! overview consume, from one whole-document parse.
//!
//! comrak already excludes a `#` inside a code fence or the frontmatter block,
//! so no fence-toggling scan is needed for heading detection.

use mdstruct::{Heading, Inline, Options, parse};

/// Which headings count as section openers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum HeadingRule {
    /// CommonMark: every ATX/setext heading with non-empty text, including the
    /// 0–3-space indents CommonMark allows. The general reader's default.
    #[default]
    CommonMark,
    /// Vault-strict: column-1, non-setext ATX headings only. Reproduces
    /// vault-query's historical `read` behavior (its `markdown.rs` scanner
    /// rejected any leading whitespace).
    StrictColumn1,
}

/// Which inlines count as outgoing links.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LinkRule {
    /// Everything that points somewhere: `[text](url)`, `<url>`, and `[[wiki]]`.
    /// The general reader's default — a plain Markdown file has no wikilinks,
    /// and reporting zero links for it would be a lie.
    #[default]
    All,
    /// `[[wiki]]` only — the Obsidian graph edge. Reproduces vault-query's
    /// historical count, which measures the vault's link graph and must not
    /// grow by counting URLs.
    Wikilinks,
}

/// One outgoing link located by mdstruct.
#[derive(Debug, Clone, PartialEq)]
pub struct OutLink {
    /// mdstruct's inline kind: `wikilink`, `link`, or `autolink`.
    pub kind: &'static str,
    /// Where it points: the wikilink target, or the URL.
    pub target: String,
    /// Display text, when it differs from the target: a wikilink's `|alias`, a
    /// link's label. `None` for an autolink and for a bare `[[X]]`.
    pub alias: Option<String>,
    /// 1-based line the link starts on.
    pub line: usize,
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

/// The body's outgoing links in document order under `rule`. Read from mdstruct
/// inlines, so a link inside a code fence is already excluded and a
/// reference-style `[a][b]` arrives with its definition resolved.
pub fn links(content: &str, rule: LinkRule) -> Vec<OutLink> {
    let opts = Options { wikilinks: true };
    let doc = parse(content, &opts);
    let mut out = Vec::new();
    for inline in doc.inlines() {
        match inline {
            Inline::Wikilink {
                target,
                alias,
                start_line,
                ..
            } => out.push(OutLink {
                kind: "wikilink",
                target: target.clone(),
                // `[[X|]]` carries an empty alias: a pipe with nothing after it
                // displays as nothing extra, so it reads as no alias.
                alias: alias.clone().filter(|a| !a.is_empty()),
                line: *start_line as usize,
            }),
            // Markdown links point outward too, but only the general rule counts
            // them: the wikilink rule measures a note graph, not the open web.
            Inline::Link { .. } | Inline::Autolink { .. } if rule == LinkRule::Wikilinks => {}
            Inline::Link {
                url,
                text_span,
                start_line,
                ..
            } => {
                let text = content
                    .get(text_span.start..text_span.end)
                    .unwrap_or("")
                    .trim();
                out.push(OutLink {
                    kind: "link",
                    target: url.clone(),
                    alias: (!text.is_empty() && text != url).then(|| text.to_string()),
                    line: *start_line as usize,
                });
            }
            Inline::Autolink { url, start_line, .. } => out.push(OutLink {
                kind: "autolink",
                target: url.clone(),
                alias: None,
                line: *start_line as usize,
            }),
            // An image points at an asset it renders, not at a document to read;
            // a code span and a footnote ref point nowhere outside the file.
            _ => {}
        }
    }
    out
}

/// Number of outgoing links — the overview's `links:` count.
pub fn link_count(content: &str, rule: LinkRule) -> usize {
    links(content, rule).len()
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

    // --- links ---

    /// One of each shape a plain Markdown file uses, plus two wikilinks.
    const LINKY: &str = "# T\n\nInline [the text](https://a.example) and <https://b.example>.\n\nRef [label][d] and [[Some Note]] and [[Other|alias]].\n\n![pic](img.png)\n\n[d]: https://d.example\n";

    #[test]
    fn all_rule_counts_markdown_links_wikilink_rule_does_not() {
        // The whole point of the rule: a plain Markdown file has real outgoing
        // links, and the wikilink-only count reports zero for it.
        assert_eq!(link_count(LINKY, LinkRule::All), 5);
        assert_eq!(link_count(LINKY, LinkRule::Wikilinks), 2);
        let plain = "See [a](https://a.example) and <https://b.example>.\n";
        assert_eq!(link_count(plain, LinkRule::All), 2);
        assert_eq!(link_count(plain, LinkRule::Wikilinks), 0);
    }

    #[test]
    fn kinds_targets_and_aliases() {
        let ls = links(LINKY, LinkRule::All);
        let by_kind: Vec<&'static str> = ls.iter().map(|l| l.kind).collect();
        assert_eq!(
            by_kind,
            vec!["link", "autolink", "link", "wikilink", "wikilink"]
        );
        // A link's label becomes the alias; an autolink has none.
        assert_eq!(ls[0].target, "https://a.example");
        assert_eq!(ls[0].alias.as_deref(), Some("the text"));
        assert_eq!(ls[1].target, "https://b.example");
        assert_eq!(ls[1].alias, None);
        // A reference-style link arrives with its definition resolved.
        assert_eq!(ls[2].target, "https://d.example");
        assert_eq!(ls[2].alias.as_deref(), Some("label"));
        // A bare wikilink has no alias; a piped one does.
        assert_eq!(ls[3].target, "Some Note");
        assert_eq!(ls[3].alias, None);
        assert_eq!(ls[4].target, "Other");
        assert_eq!(ls[4].alias.as_deref(), Some("alias"));
    }

    #[test]
    fn images_are_not_outgoing_links() {
        // `![pic](img.png)` renders an asset; it is not a document to read.
        assert!(!links(LINKY, LinkRule::All).iter().any(|l| l.target == "img.png"));
    }

    #[test]
    fn fenced_links_are_excluded() {
        let c = "```\n[not a link](https://x.example)\n[[Not A Note]]\n```\n\n[real](https://y.example)\n";
        let ls = links(c, LinkRule::All);
        assert_eq!(ls.len(), 1);
        assert_eq!(ls[0].target, "https://y.example");
    }

    #[test]
    fn lines_are_reported() {
        let ls = links(LINKY, LinkRule::All);
        assert_eq!(ls[0].line, 3);
        assert_eq!(ls[3].line, 5);
    }
}
