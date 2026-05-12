use crate::commands::lint::rule::{Finding, LintContext, Rule, Severity};
use pulldown_cmark::{Event, HeadingLevel, Parser, Tag, TagEnd};

pub struct DuplicateH1;

impl Rule for DuplicateH1 {
    fn name(&self) -> &'static str {
        "duplicate-h1"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warn
    }

    fn check(&self, ctx: &LintContext) -> Vec<Finding> {
        let mut findings = Vec::new();

        for file in ctx.files {
            let body = crate::frontmatter::body(&file.content);
            if body.trim().is_empty() {
                continue;
            }

            if let Some(h1_text) = first_h1_if_structural_start(body) {
                if h1_text == file.name {
                    findings.push(Finding {
                        rule: self.name(),
                        severity: self.default_severity(),
                        file: file.path.clone(),
                        message: format!(
                            "first body heading `# {}` duplicates the filename",
                            file.name
                        ),
                        data: None,
                    });
                }
            }
        }

        findings
    }
}

/// Walk the CommonMark events for `body` and return the text of the first H1
/// if the very first structural event (at code-block depth 0) is an H1 start.
/// Returns `None` if the first structural event is not an H1, or if there is
/// no H1 at all.
fn first_h1_if_structural_start(body: &str) -> Option<String> {
    let mut in_code_depth: u32 = 0;
    let mut found_first_structural = false;
    let mut collecting_h1 = false;
    let mut h1_parts: Vec<String> = Vec::new();

    for event in Parser::new(body) {
        match &event {
            Event::Start(Tag::CodeBlock(_)) => {
                in_code_depth += 1;
            }
            Event::End(TagEnd::CodeBlock) => {
                in_code_depth = in_code_depth.saturating_sub(1);
            }
            _ if in_code_depth > 0 => {
                // Inside a code block — ignore entirely.
            }
            Event::Start(Tag::Heading {
                level: HeadingLevel::H1,
                ..
            }) if !found_first_structural => {
                found_first_structural = true;
                collecting_h1 = true;
            }
            Event::End(TagEnd::Heading(_)) if collecting_h1 => {
                let text = h1_parts.join("").trim().to_string();
                return Some(text);
            }
            Event::Text(t) if collecting_h1 => {
                h1_parts.push(t.to_string());
            }
            // Any structural Start event at depth 0 that is not an H1, and
            // appears before we have found the first structural event, means
            // the first element is not an H1 — bail out immediately.
            Event::Start(_) if !found_first_structural => {
                return None;
            }
            _ => {}
        }
    }

    None
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

    fn check(files: &[crate::vault::VaultFile]) -> Vec<Finding> {
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, files, &[]);
        DuplicateH1.check(&ctx)
    }

    #[test]
    fn matching_h1_emits_finding() {
        let file = make_file("Foo", "# Foo\n\nbody text");
        let findings = check(&[file]);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, "duplicate-h1");
        assert_eq!(
            findings[0].message,
            "first body heading `# Foo` duplicates the filename"
        );
    }

    #[test]
    fn mismatched_heading_emits_nothing() {
        let file = make_file("Foo", "# Bar\nbody");
        let findings = check(&[file]);
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn paragraph_before_h1_emits_nothing() {
        let file = make_file("Foo", "body text\n\n# Foo");
        let findings = check(&[file]);
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn h1_inside_code_fence_emits_nothing() {
        let file = make_file("Foo", "```\n# Foo\n```\nactual body");
        let findings = check(&[file]);
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn empty_file_emits_nothing() {
        let file = make_file("Foo", "");
        let findings = check(&[file]);
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn whitespace_only_emits_nothing() {
        let file = make_file("Foo", "   \n\n  ");
        let findings = check(&[file]);
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn frontmatter_then_matching_h1_emits_finding() {
        let file = make_file("Foo", "---\ntype: card\n---\n# Foo\nbody");
        let findings = check(&[file]);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, "duplicate-h1");
    }
}
