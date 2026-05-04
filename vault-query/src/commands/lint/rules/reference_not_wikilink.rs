use crate::commands::lint::rule::{Finding, LintContext, Rule, Severity};
use crate::wikilink;

pub struct ReferenceNotWikilink;

impl Rule for ReferenceNotWikilink {
    fn name(&self) -> &'static str {
        "reference-not-wikilink"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warn
    }

    fn check(&self, ctx: &LintContext) -> Vec<Finding> {
        let mut findings = Vec::new();
        for card in &ctx.cards {
            if let Some(value) = card.frontmatter.get("reference") {
                check_value(card, value, self.name(), self.default_severity(), &mut findings);
            }
        }
        findings
    }
}

fn check_value(
    card: &crate::vault::VaultFile,
    value: &serde_yaml::Value,
    rule_name: &'static str,
    severity: Severity,
    findings: &mut Vec<Finding>,
) {
    match value {
        serde_yaml::Value::String(s) => {
            if wikilink::extract(s).is_empty() {
                let truncated = if s.chars().count() > 80 {
                    let mut t: String = s.chars().take(77).collect();
                    t.push_str("...");
                    t
                } else {
                    s.clone()
                };
                findings.push(Finding {
                    rule: rule_name,
                    severity,
                    file: card.path.clone(),
                    message: format!(
                        "card '{}' has non-wikilink reference: '{}'",
                        card.name, truncated
                    ),
                    data: Some(serde_json::json!({ "value": s })),
                });
            }
        }
        serde_yaml::Value::Sequence(items) => {
            for item in items {
                check_value(card, item, rule_name, severity, findings);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::lint::rule::LintContext;
    use serde_yaml::Value;
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    fn card_file(name: &str, reference: Option<Value>) -> crate::vault::VaultFile {
        let mut fm = BTreeMap::new();
        fm.insert("type".to_string(), Value::String("card".to_string()));
        if let Some(r) = reference {
            fm.insert("reference".to_string(), r);
        }
        crate::vault::VaultFile {
            name: name.to_string(),
            path: PathBuf::from(format!("/vault/20 cards/{}.md", name)),
            frontmatter: fm,
            ..Default::default()
        }
    }

    fn run(card: crate::vault::VaultFile) -> Vec<Finding> {
        let files = vec![card];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);
        ReferenceNotWikilink.check(&ctx)
    }

    #[test]
    fn reference_not_wikilink_raw_url_emits_finding() {
        let card = card_file("Foo", Some(Value::String("https://example.com".to_string())));
        let findings = run(card);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, "reference-not-wikilink");
        let data = findings[0].data.as_ref().unwrap();
        assert_eq!(data["value"], "https://example.com");
    }

    #[test]
    fn reference_wikilink_emits_nothing() {
        let card = card_file("Foo", Some(Value::String("[[Foo]]".to_string())));
        let findings = run(card);
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn reference_list_with_mixed_emits_per_non_wikilink() {
        let list = Value::Sequence(vec![
            Value::String("[[Foo]]".to_string()),
            Value::String("https://bar".to_string()),
            Value::String("plain text".to_string()),
        ]);
        let card = card_file("Foo", Some(list));
        let findings = run(card);
        assert_eq!(findings.len(), 2);

        let messages: Vec<&str> = findings.iter().map(|f| f.message.as_str()).collect();
        assert!(messages.iter().any(|m| m.contains("https://bar")));
        assert!(messages.iter().any(|m| m.contains("plain text")));
    }

    #[test]
    fn card_without_reference_field_emits_nothing() {
        let card = card_file("Foo", None);
        let findings = run(card);
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn reference_nested_list_walks_recursively() {
        let nested = Value::Sequence(vec![Value::Sequence(vec![Value::String(
            "https://x".to_string(),
        )])]);
        let card = card_file("Foo", Some(nested));
        let findings = run(card);
        assert_eq!(findings.len(), 1);
        let data = findings[0].data.as_ref().unwrap();
        assert_eq!(data["value"], "https://x");
    }

    #[test]
    fn reference_value_not_string_or_list_emits_nothing() {
        let card = card_file("Foo", Some(Value::Number(42.into())));
        let findings = run(card);
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn reference_long_string_is_truncated_in_message() {
        let long_url: String = "https://example.com/".to_string() + &"a".repeat(180);
        assert!(long_url.chars().count() > 80);

        let card = card_file("Foo", Some(Value::String(long_url.clone())));
        let findings = run(card);
        assert_eq!(findings.len(), 1);

        let msg = &findings[0].message;
        assert!(msg.contains("..."), "message should contain '...'");
        assert!(
            msg.len() < long_url.len(),
            "message should be shorter than the full string"
        );

        let data = findings[0].data.as_ref().unwrap();
        assert_eq!(data["value"], long_url, "data.value should hold the full string");
    }
}
