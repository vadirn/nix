use crate::commands::lint::rule::{Finding, LintContext, Rule, Severity};
use crate::frontmatter;

pub struct MissingRequiredField;

/// Required fields per `type:` value.
/// "Missing" means the key is absent from frontmatter. A key present with an empty string
/// or null value counts as present for v1.
///
/// TODO: "blank-but-present" (key exists but value is empty/null) could become a separate rule later.
fn required_fields(type_val: &str) -> Option<&'static [&'static str]> {
    match type_val {
        "card" => Some(&["description", "tags", "reference"]),
        "note" => Some(&["description", "tags"]),
        "reference" => Some(&["description", "tags"]),
        "project" => Some(&["result", "status", "goal"]),
        "track" => Some(&["slug", "description", "status", "project", "created", "updated"]),
        "checkpoint" => Some(&[]),
        "weekly-log" => Some(&["week", "start", "end", "sleep"]),
        "goal" => Some(&["description", "tags"]),
        _ => None,
    }
}

impl Rule for MissingRequiredField {
    fn name(&self) -> &'static str {
        "missing-required-field"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warn
    }

    fn check(&self, ctx: &LintContext) -> Vec<Finding> {
        let mut findings = Vec::new();

        for file in ctx.files {
            // Skip templates — they legitimately have empty fields.
            if frontmatter::get_bool(&file.frontmatter, "template") == Some(true) {
                continue;
            }

            let type_val = frontmatter::get_display(&file.frontmatter, "type");
            if type_val.is_empty() {
                continue;
            }

            let Some(fields) = required_fields(&type_val) else {
                continue;
            };

            for field in fields {
                if !file.frontmatter.contains_key(*field) {
                    findings.push(Finding {
                        rule: self.name(),
                        severity: self.default_severity(),
                        file: file.path.clone(),
                        message: format!(
                            "{} file is missing required field '{}'",
                            type_val, field
                        ),
                        data: None,
                    });
                }
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
        fields: &[(&str, Value)],
    ) -> crate::vault::VaultFile {
        let mut fm = BTreeMap::new();
        for (k, v) in fields {
            fm.insert(k.to_string(), v.clone());
        }
        crate::vault::VaultFile {
            name: name.to_string(),
            path: PathBuf::from(path),
            frontmatter: fm,
            ..Default::default()
        }
    }

    #[test]
    fn card_missing_all_required_fields_emits_three_findings() {
        let file = make_file(
            "MyCard",
            "/vault/20 cards/MyCard.md",
            &[("type", Value::String("card".into()))],
        );
        let files = vec![file];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = MissingRequiredField.check(&ctx);
        assert_eq!(findings.len(), 3);

        let messages: Vec<&str> = findings.iter().map(|f| f.message.as_str()).collect();
        assert!(messages.contains(&"card file is missing required field 'description'"));
        assert!(messages.contains(&"card file is missing required field 'tags'"));
        assert!(messages.contains(&"card file is missing required field 'reference'"));
    }

    #[test]
    fn card_with_all_required_fields_emits_nothing() {
        let file = make_file(
            "FullCard",
            "/vault/20 cards/FullCard.md",
            &[
                ("type", Value::String("card".into())),
                ("description", Value::String("A description".into())),
                ("tags", Value::Sequence(vec![Value::String("foo".into())])),
                ("reference", Value::String("[[SomeRef]]".into())),
            ],
        );
        let files = vec![file];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = MissingRequiredField.check(&ctx);
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn template_file_is_skipped() {
        let file = make_file(
            "CardTemplate",
            "/vault/templates/card.md",
            &[
                ("type", Value::String("card".into())),
                ("template", Value::Bool(true)),
            ],
        );
        let files = vec![file];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = MissingRequiredField.check(&ctx);
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn file_without_type_is_skipped() {
        let file = make_file(
            "Untyped",
            "/vault/Untyped.md",
            &[("description", Value::String("no type here".into()))],
        );
        let files = vec![file];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = MissingRequiredField.check(&ctx);
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn file_with_unrecognized_type_is_skipped() {
        let file = make_file(
            "Weird",
            "/vault/Weird.md",
            &[("type", Value::String("custom-thing".into()))],
        );
        let files = vec![file];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = MissingRequiredField.check(&ctx);
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn empty_string_field_counts_as_present() {
        // v1: blank-but-present is not flagged (key exists in frontmatter).
        let file = make_file(
            "PartialCard",
            "/vault/20 cards/PartialCard.md",
            &[
                ("type", Value::String("card".into())),
                ("description", Value::String(String::new())),
                ("tags", Value::Sequence(vec![])),
                ("reference", Value::String(String::new())),
            ],
        );
        let files = vec![file];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = MissingRequiredField.check(&ctx);
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn project_requires_result_status_goal_not_deadline() {
        // deadline was dropped; result, status, goal remain required.
        let file = make_file(
            "MyProject",
            "/vault/41 projects/my-project/my-project.md",
            &[
                ("type", Value::String("project".into())),
                ("result", Value::String("done".into())),
                ("status", Value::String("active".into())),
                ("goal", Value::String("ship it".into())),
                // deadline intentionally absent — must not produce a finding
            ],
        );
        let files = vec![file];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = MissingRequiredField.check(&ctx);
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn project_missing_required_fields_emits_three_findings() {
        let file = make_file(
            "BareProject",
            "/vault/41 projects/bare/bare.md",
            &[("type", Value::String("project".into()))],
        );
        let files = vec![file];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = MissingRequiredField.check(&ctx);
        assert_eq!(findings.len(), 3);

        let messages: Vec<&str> = findings.iter().map(|f| f.message.as_str()).collect();
        assert!(messages.contains(&"project file is missing required field 'result'"));
        assert!(messages.contains(&"project file is missing required field 'status'"));
        assert!(messages.contains(&"project file is missing required field 'goal'"));
        assert!(!messages.contains(&"project file is missing required field 'deadline'"));
    }

    #[test]
    fn checkpoint_has_no_required_fields() {
        // description was dropped from checkpoint; any checkpoint should produce no findings.
        let file = make_file(
            "MyCheckpoint",
            "/vault/41 projects/nix/checkpoint-20260507.md",
            &[("type", Value::String("checkpoint".into()))],
        );
        let files = vec![file];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = MissingRequiredField.check(&ctx);
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn track_missing_fields_emits_correct_findings() {
        let file = make_file(
            "MyTrack",
            "/vault/41 projects/my-project/track-foo.md",
            &[
                ("type", Value::String("track".into())),
                ("slug", Value::String("foo".into())),
            ],
        );
        let files = vec![file];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = MissingRequiredField.check(&ctx);
        // track requires: slug, description, status, project, created, updated (6 total)
        // slug is present, so 5 missing
        assert_eq!(findings.len(), 5);

        let messages: Vec<&str> = findings.iter().map(|f| f.message.as_str()).collect();
        assert!(!messages.contains(&"track file is missing required field 'slug'"));
        assert!(messages.contains(&"track file is missing required field 'description'"));
        assert!(messages.contains(&"track file is missing required field 'status'"));
        assert!(messages.contains(&"track file is missing required field 'project'"));
        assert!(messages.contains(&"track file is missing required field 'created'"));
        assert!(messages.contains(&"track file is missing required field 'updated'"));
    }
}
