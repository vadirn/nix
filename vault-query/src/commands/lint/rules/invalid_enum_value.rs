use crate::commands::lint::rule::{Finding, LintContext, Rule, Severity};
use crate::commands::lint::schema::build_type_schemas;
use crate::frontmatter;
use serde_yaml::Value;

/// Flags a frontmatter picker field whose scalar-string value is not one of the
/// options its type's template declares.
///
/// Only scalar-string values are checked: a `Null`/empty or `Sequence` value is
/// skipped so an unfilled or multi-valued field never over-flags. Entries of
/// un-templated types (no schema) and lint-exempt entries are skipped.
pub struct InvalidEnumValue;

impl Rule for InvalidEnumValue {
    fn name(&self) -> &'static str {
        "invalid-enum-value"
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

            let Some(schema) = schemas.get(&type_val) else {
                continue;
            };

            for (key, value) in &file.frontmatter {
                let Some(options) = schema.enums.get(key) else {
                    continue;
                };
                // Only a scalar string is checked; Null/Sequence/etc. skip.
                let Value::String(s) = value else {
                    continue;
                };
                // An empty string is an unfilled picker, not a wrong value.
                if s.is_empty() {
                    continue;
                }
                if !options.contains(s) {
                    let joined: Vec<String> = options.iter().cloned().collect();
                    findings.push(Finding {
                        rule: self.name(),
                        severity: self.default_severity(),
                        file: file.path.clone(),
                        message: format!(
                            "frontmatter field '{}' value '{}' not one of: {}",
                            key,
                            s,
                            joined.join(", ")
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

    /// A ticket template with a `status` picker: open, done.
    fn ticket_template() -> crate::vault::VaultFile {
        make_file(
            "Ticket",
            "/vault/templates/Ticket.md",
            &[
                ("type", Value::String("ticket".into())),
                ("template", Value::Bool(true)),
                (
                    "status",
                    Value::Sequence(vec![
                        Value::String("open".into()),
                        Value::String("done".into()),
                    ]),
                ),
            ],
        )
    }

    fn ticket(status: Value) -> crate::vault::VaultFile {
        make_file(
            "MyTicket",
            "/vault/41 projects/p/ticket-x.md",
            &[("type", Value::String("ticket".into())), ("status", status)],
        )
    }

    #[test]
    fn valid_enum_value_passes() {
        let files = vec![ticket_template(), ticket(Value::String("open".into()))];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = InvalidEnumValue.check(&ctx);
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn invalid_enum_value_flags() {
        let files = vec![ticket_template(), ticket(Value::String("bogus".into()))];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = InvalidEnumValue.check(&ctx);
        assert_eq!(findings.len(), 1);
        // BTreeSet options render sorted: done, open.
        assert_eq!(
            findings[0].message,
            "frontmatter field 'status' value 'bogus' not one of: done, open"
        );
    }

    #[test]
    fn empty_string_picker_does_not_flag() {
        let files = vec![ticket_template(), ticket(Value::String(String::new()))];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = InvalidEnumValue.check(&ctx);
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn null_picker_does_not_flag() {
        let files = vec![ticket_template(), ticket(Value::Null)];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = InvalidEnumValue.check(&ctx);
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn sequence_picker_value_does_not_flag() {
        // A multi-valued field is not a single-choice picker mismatch.
        let files = vec![
            ticket_template(),
            ticket(Value::Sequence(vec![Value::String("bogus".into())])),
        ];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = InvalidEnumValue.check(&ctx);
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn entry_of_untemplated_type_does_not_flag() {
        // `spike` has no template → no schema; a stray status value is not checked.
        let entry = make_file(
            "MySpike",
            "/vault/20 cards/MySpike.md",
            &[
                ("type", Value::String("spike".into())),
                ("status", Value::String("bogus".into())),
            ],
        );
        let files = vec![ticket_template(), entry];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = InvalidEnumValue.check(&ctx);
        assert_eq!(findings.len(), 0);
    }
}
