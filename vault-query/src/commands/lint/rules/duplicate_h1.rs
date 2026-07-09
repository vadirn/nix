use crate::commands::lint::rule::{Finding, LintContext, Rule, Severity};

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
            if let Some(h1_text) = crate::mdfacet::first_body_block_h1(&file.content)
                && h1_text == file.name
            {
                findings.push(Finding {
                    rule: self.name(),
                    severity: self.default_severity(),
                    file: file.path.clone(),
                    message: format!("first body heading `# {}` duplicates the filename", file.name),
                    data: None,
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
