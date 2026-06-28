use crate::commands::lint::relations::is_known_rel;
use crate::commands::lint::rule::{Finding, LintContext, Rule, Severity};

/// `unknown-rel` — a soft registry nudge (D32). A `<rel>` token outside the open
/// `REL_REGISTRY` is not an error: the edge is kept (lossy parse, D29) and surfaced
/// at `Warn` (config-downgradable to Off) so the curator can canonicalize a typo or
/// promote a genuinely new relation into the registry.
pub struct UnknownRel;

impl Rule for UnknownRel {
    fn name(&self) -> &'static str {
        "unknown-rel"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warn
    }

    fn check(&self, ctx: &LintContext) -> Vec<Finding> {
        let mut findings = Vec::new();
        for (file, edges) in ctx.files.iter().zip(&ctx.relations) {
            for edge in edges {
                if is_known_rel(&edge.rel) {
                    continue;
                }
                findings.push(Finding {
                    rule: self.name(),
                    severity: self.default_severity(),
                    file: file.path.clone(),
                    message: format!(
                        "relation '{}' is not in the known registry",
                        edge.rel
                    ),
                    data: Some(serde_json::json!({ "rel": edge.rel, "line": edge.line })),
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

    fn file_with(content: &str) -> crate::vault::VaultFile {
        crate::vault::VaultFile {
            name: "Note".to_string(),
            path: PathBuf::from("/vault/Note.md"),
            content: content.to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn known_rels_emit_nothing() {
        let files = vec![file_with("## Relations\n\n- a subsumes:: b\n- c refines:: d\n")];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);
        assert!(UnknownRel.check(&ctx).is_empty());
    }

    #[test]
    fn unknown_rel_emits_finding_with_rel_and_line() {
        let files = vec![file_with("## Relations\n\n- a relates-to:: b\n")];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = UnknownRel.check(&ctx);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, "unknown-rel");
        let data = findings[0].data.as_ref().unwrap();
        assert_eq!(data["rel"], "relates-to");
        assert_eq!(data["line"], 3);
    }

    #[test]
    fn default_severity_is_warn() {
        assert_eq!(UnknownRel.default_severity(), Severity::Warn);
    }
}
