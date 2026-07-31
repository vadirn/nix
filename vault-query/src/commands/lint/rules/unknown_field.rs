use crate::commands::lint::rule::{Finding, LintContext, Rule, Severity};
use crate::commands::lint::schema::build_type_schemas;
use crate::frontmatter;

/// Flags a frontmatter key that is not in its type's template-derived schema.
///
/// Only entries whose `type` HAS a template (thus a schema) are checked; an entry
/// of an un-templated type is skipped entirely, never flagged. Lint-exempt entries
/// (templates, superseded, checkpoint) are skipped too.
pub struct UnknownField;

impl Rule for UnknownField {
    fn name(&self) -> &'static str {
        "unknown-field"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warn
    }

    fn check(&self, ctx: &LintContext) -> Vec<Finding> {
        let schemas = build_type_schemas(ctx);
        let mut findings = Vec::new();

        for file in ctx.files {
            if crate::epistemic::is_lint_exempt(&file.frontmatter) {
                continue;
            }

            let type_val = frontmatter::get_display(&file.frontmatter, "type");
            if type_val.is_empty() {
                continue;
            }

            // No schema → the type has no template; do not flag its entries.
            let Some(schema) = schemas.get(&type_val) else {
                continue;
            };

            for key in file.frontmatter.keys() {
                if !schema.allowed.contains(key) {
                    findings.push(Finding {
                        rule: self.name(),
                        severity: self.default_severity(),
                        file: file.path.clone(),
                        message: format!(
                            "unknown frontmatter field '{}' for type '{}'",
                            key, type_val
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

    fn make_file(name: &str, path: &str, fields: &[(&str, Value)]) -> crate::vault::VaultFile {
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

    /// A card template establishing the `card` schema: allowed keys are
    /// type, template, description, tags.
    fn card_template() -> crate::vault::VaultFile {
        make_file(
            "Card",
            "/vault/templates/Card.md",
            &[
                ("type", Value::String("card".into())),
                ("template", Value::Bool(true)),
                ("description", Value::String(String::new())),
                ("tags", Value::Sequence(vec![])),
            ],
        )
    }

    #[test]
    fn unknown_field_flags() {
        let entry = make_file(
            "MyCard",
            "/vault/20 cards/MyCard.md",
            &[
                ("type", Value::String("card".into())),
                ("description", Value::String("hi".into())),
                ("bogus", Value::String("x".into())),
            ],
        );
        let files = vec![card_template(), entry];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = UnknownField.check(&ctx);
        assert_eq!(findings.len(), 1);
        assert_eq!(
            findings[0].message,
            "unknown frontmatter field 'bogus' for type 'card'"
        );
    }

    #[test]
    fn universal_meta_field_does_not_flag() {
        // `related` is in the universal meta-set, not the card template.
        let entry = make_file(
            "MyCard",
            "/vault/20 cards/MyCard.md",
            &[
                ("type", Value::String("card".into())),
                ("description", Value::String("hi".into())),
                (
                    "related",
                    Value::Sequence(vec![Value::String("[[X]]".into())]),
                ),
            ],
        );
        let files = vec![card_template(), entry];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = UnknownField.check(&ctx);
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn entry_of_untemplated_type_does_not_flag() {
        // `spike` has no template → no schema → not checked, even with a stray field.
        let entry = make_file(
            "MySpike",
            "/vault/20 cards/MySpike.md",
            &[
                ("type", Value::String("spike".into())),
                ("whatever", Value::String("x".into())),
            ],
        );
        let files = vec![card_template(), entry];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = UnknownField.check(&ctx);
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn template_entry_is_skipped() {
        // The template itself is lint-exempt; only the entry (with no drift) is left.
        let entry = make_file(
            "GoodCard",
            "/vault/20 cards/GoodCard.md",
            &[
                ("type", Value::String("card".into())),
                ("description", Value::String("hi".into())),
                ("tags", Value::Sequence(vec![Value::String("t".into())])),
            ],
        );
        let files = vec![card_template(), entry];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = UnknownField.check(&ctx);
        assert_eq!(findings.len(), 0);
    }
}
