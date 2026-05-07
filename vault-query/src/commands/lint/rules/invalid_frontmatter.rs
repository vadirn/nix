use crate::commands::lint::rule::{Finding, LintContext, Rule, Severity};

pub struct InvalidFrontmatter;

impl Rule for InvalidFrontmatter {
    fn name(&self) -> &'static str {
        "invalid-frontmatter"
    }

    fn default_severity(&self) -> Severity {
        Severity::Error
    }

    fn check(&self, ctx: &LintContext) -> Vec<Finding> {
        let mut findings = Vec::new();
        for file in ctx.files {
            if let Some(err) = &file.frontmatter_error {
                findings.push(Finding {
                    rule: self.name(),
                    severity: self.default_severity(),
                    file: file.path.clone(),
                    message: format!("frontmatter parse error: {}", err),
                    data: Some(serde_json::json!({ "error": err })),
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

    fn file_with_error(name: &str, path: &str, error: &str) -> crate::vault::VaultFile {
        crate::vault::VaultFile {
            name: name.to_string(),
            path: PathBuf::from(path),
            frontmatter_error: Some(error.to_string()),
            ..Default::default()
        }
    }

    fn ok_file(name: &str, path: &str) -> crate::vault::VaultFile {
        crate::vault::VaultFile {
            name: name.to_string(),
            path: PathBuf::from(path),
            ..Default::default()
        }
    }

    #[test]
    fn invalid_frontmatter_emits_finding_per_broken_file() {
        let files = vec![
            file_with_error(
                "Bad",
                "/vault/30 notes/Bad.md",
                "mapping values are not allowed in this context at line 4 column 28",
            ),
            ok_file("Good", "/vault/30 notes/Good.md"),
        ];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = InvalidFrontmatter.check(&ctx);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, "invalid-frontmatter");
        assert_eq!(findings[0].severity, Severity::Error);
        assert_eq!(findings[0].file, PathBuf::from("/vault/30 notes/Bad.md"));
        assert!(findings[0].message.contains("mapping values are not allowed"));
    }

    #[test]
    fn invalid_frontmatter_finding_carries_error_in_data() {
        let files = vec![file_with_error(
            "Bad",
            "/vault/30 notes/Bad.md",
            "expected scalar at line 2",
        )];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = InvalidFrontmatter.check(&ctx);
        let data = findings[0].data.as_ref().expect("data present");
        assert_eq!(data["error"], "expected scalar at line 2");
    }

    #[test]
    fn invalid_frontmatter_no_findings_when_all_valid() {
        let files = vec![ok_file("A", "/vault/A.md"), ok_file("B", "/vault/B.md")];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = InvalidFrontmatter.check(&ctx);
        assert!(findings.is_empty());
    }
}
