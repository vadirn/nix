//! `callout-missing-separator` — flags an Obsidian callout whose `[!Type]` header
//! line and body sit in one CommonMark paragraph.
//!
//! `autoformat` routes `.md` to `oxfmt` with `proseWrap: never`, which joins every
//! line of a paragraph onto one line. A callout is an ordinary blockquote to the
//! formatter, so the header line and the body line directly beneath it are one
//! paragraph and get joined — and Obsidian reads whatever follows `[!Type]` on the
//! header line as the callout's *title*, so the body silently becomes the title and
//! disappears on render. Upstream is Prettier issue 19067 (no maintainer response);
//! oxfmt advertises Prettier v3.8 compatibility, so it reproducing this is
//! compatibility working as intended.
//!
//! The verified-safe shape is a blank quoted `>` line between header and body,
//! which survives bare `oxfmt` unchanged. This rule enforces it.

use crate::commands::lint::rule::{Finding, LintContext, Rule, Severity};

pub struct CalloutMissingSeparator;

impl Rule for CalloutMissingSeparator {
    fn name(&self) -> &'static str {
        "callout-missing-separator"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warn
    }

    fn check(&self, ctx: &LintContext) -> Vec<Finding> {
        let mut findings = Vec::new();

        for file in ctx.files {
            for callout in crate::mdfacet::unseparated_callouts(&file.content) {
                findings.push(Finding {
                    rule: self.name(),
                    severity: self.default_severity(),
                    file: file.path.clone(),
                    // `Finding` carries no line field, so the line rides in both the
                    // human-readable message and the structured payload.
                    message: format!(
                        "line {}: callout `[!{}]` has no blank `>` line before its body — a `proseWrap: never` format joins the body into the title",
                        callout.line, callout.kind
                    ),
                    data: Some(
                        serde_json::json!({ "line": callout.line, "callout": callout.kind }),
                    ),
                });
            }
        }

        findings
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::lint::rule::LintContext;
    use std::path::PathBuf;

    fn make_file(name: &str, content: &str) -> crate::vault::VaultFile {
        crate::vault::VaultFile {
            name: name.to_string(),
            path: PathBuf::from(format!("/vault/{}.md", name)),
            content: content.to_string(),
            ..Default::default()
        }
    }

    fn check(content: &str) -> Vec<Finding> {
        let files = vec![make_file("Foo", content)];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);
        CalloutMissingSeparator.check(&ctx)
    }

    #[test]
    fn joined_header_and_body_emits_one_finding() {
        let findings = check("intro\n\n> [!Abstract]\n> Professionals improve.\n");
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, "callout-missing-separator");
        assert_eq!(findings[0].severity, Severity::Warn);
        // Header sits on source line 3; both channels must say so.
        assert!(
            findings[0]
                .message
                .starts_with("line 3: callout `[!Abstract]`"),
            "message was {:?}",
            findings[0].message
        );
        assert_eq!(findings[0].data.as_ref().unwrap()["line"], 3);
        assert_eq!(findings[0].data.as_ref().unwrap()["callout"], "Abstract");
    }

    #[test]
    fn fold_marker_header_still_flagged() {
        let findings = check("> [!Note]-\n> Body.\n");
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].data.as_ref().unwrap()["callout"], "Note");
    }

    #[test]
    fn titled_header_joined_to_body_emits_one_finding() {
        let findings = check("> [!Note] Some title\n> Body.\n");
        assert_eq!(findings.len(), 1);
    }

    #[test]
    fn safe_bare_header_emits_nothing() {
        let findings = check("> [!Abstract]\n>\n> Professionals improve.\n");
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn safe_titled_header_emits_nothing() {
        let findings = check("> [!Note] Some title\n>\n> Body.\n");
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn safe_two_paragraph_body_emits_nothing() {
        let findings = check("> [!Abstract]\n>\n> One.\n>\n> Two.\n");
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn damaged_callout_inside_code_fence_emits_nothing() {
        let findings = check("```md\n> [!Note]\n> Body.\n```\n");
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn header_with_no_body_emits_nothing() {
        let findings = check("> [!Note]\n\ntext after\n");
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn plain_multiline_blockquote_emits_nothing() {
        let findings = check("> just a quote\n> second line\n");
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn nested_callout_emits_one_finding() {
        let findings = check("> > [!Note]\n> > Body.\n");
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].data.as_ref().unwrap()["line"], 1);
        assert_eq!(findings[0].data.as_ref().unwrap()["callout"], "Note");
    }

    #[test]
    fn frontmatter_offsets_do_not_shift_the_line() {
        let findings = check("---\ntype: card\n---\n\n> [!Tip]\n> Body.\n");
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].data.as_ref().unwrap()["line"], 5);
    }

    #[test]
    fn empty_file_emits_nothing() {
        let findings = check("");
        assert_eq!(findings.len(), 0);
    }
}
