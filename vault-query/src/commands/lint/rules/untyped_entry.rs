use crate::commands::lint::rule::{Finding, LintContext, Rule, Severity};
use crate::frontmatter;

/// Flags vault files that have no `type:` frontmatter field.
///
/// Every committed vault entry should carry a `type:` declaration so that
/// rules, consult scope, and the skill's command routing can treat it
/// correctly.  Files without a type are raw captures that belong in the
/// inbox only and have not been properly filed.
///
/// Exempt: templates (scaffolding, not content), superseded entries, and
/// checkpoints (`type: checkpoint` is an append-mostly project record
/// treated as superseded for lint purposes).
pub struct UntypedEntry;

impl Rule for UntypedEntry {
    fn name(&self) -> &'static str {
        "untyped-entry"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warn
    }

    fn check(&self, ctx: &LintContext) -> Vec<Finding> {
        let mut findings = Vec::new();

        for file in ctx.files {
            if crate::epistemic::is_lint_exempt(&file.frontmatter) {
                continue;
            }
            let type_val = frontmatter::get_display(&file.frontmatter, "type");
            if type_val.is_empty() {
                findings.push(Finding {
                    rule: self.name(),
                    severity: self.default_severity(),
                    file: file.path.clone(),
                    message: format!("'{}' has no type field; assign a type or move to inbox", file.name),
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
    use serde_yaml::Value;
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    fn make_file(
        name: &str,
        path: &str,
        type_val: Option<&str>,
        is_template: bool,
        is_superseded: bool,
    ) -> crate::vault::VaultFile {
        let mut fm = BTreeMap::new();
        if let Some(t) = type_val {
            fm.insert("type".to_string(), Value::String(t.to_string()));
        }
        if is_template {
            fm.insert("template".to_string(), Value::Bool(true));
        }
        if is_superseded {
            fm.insert("superseded".to_string(), Value::Bool(true));
        }
        crate::vault::VaultFile {
            name: name.to_string(),
            path: PathBuf::from(path),
            frontmatter: fm,
            ..Default::default()
        }
    }

    fn check(files: Vec<crate::vault::VaultFile>) -> Vec<Finding> {
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);
        UntypedEntry.check(&ctx)
    }

    #[test]
    fn untyped_entry_fires_when_type_absent() {
        let files = vec![make_file("Inbox capture", "/vault/Inbox capture.md", None, false, false)];
        let findings = check(files);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, "untyped-entry");
        assert_eq!(findings[0].severity, Severity::Warn);
        assert!(
            findings[0].message.contains("Inbox capture"),
            "unexpected message: {}",
            findings[0].message
        );
    }

    #[test]
    fn typed_entry_is_silent() {
        let files = vec![make_file("My Card", "/vault/20 cards/My Card.md", Some("card"), false, false)];
        assert!(check(files).is_empty());
    }

    #[test]
    fn template_without_type_is_silent() {
        let files = vec![make_file("Card Template", "/vault/templates/card.md", None, true, false)];
        assert!(check(files).is_empty());
    }

    #[test]
    fn superseded_without_type_is_silent() {
        let files = vec![make_file("Old note", "/vault/20 cards/Old note.md", None, false, true)];
        assert!(check(files).is_empty());
    }

    #[test]
    fn checkpoint_is_silent() {
        let files = vec![make_file(
            "checkpoint-001",
            "/vault/41 projects/nix/checkpoint-001.md",
            Some("checkpoint"),
            false,
            false,
        )];
        assert!(check(files).is_empty());
    }

    #[test]
    fn multiple_untyped_entries_each_get_a_finding() {
        let files = vec![
            make_file("Note A", "/vault/Note A.md", None, false, false),
            make_file("Note B", "/vault/Note B.md", None, false, false),
            make_file("Typed", "/vault/20 cards/Typed.md", Some("card"), false, false),
        ];
        let findings = check(files);
        assert_eq!(findings.len(), 2);
        let paths: Vec<&PathBuf> = findings.iter().map(|f| &f.file).collect();
        assert!(paths.contains(&&PathBuf::from("/vault/Note A.md")));
        assert!(paths.contains(&&PathBuf::from("/vault/Note B.md")));
    }
}
