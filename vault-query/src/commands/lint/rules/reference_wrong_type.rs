use std::collections::HashMap;

use crate::commands::lint::rule::{Finding, LintContext, Rule, Severity};
use crate::wikilink;
use crate::wikilink::normalize;

pub struct ReferenceWrongType;

impl Rule for ReferenceWrongType {
    fn name(&self) -> &'static str {
        "reference-wrong-type"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warn
    }

    fn check(&self, ctx: &LintContext) -> Vec<Finding> {
        let mut type_by_name: HashMap<String, String> = HashMap::new();
        for file in ctx.files {
            let type_val = crate::frontmatter::get_display(&file.frontmatter, "type");
            type_by_name.insert(normalize(&file.name), type_val);
        }

        let mut findings = Vec::new();
        for card in &ctx.cards {
            if let Some(value) = card.frontmatter.get("reference") {
                wikilink::walk_frontmatter_links(value, &mut |link| {
                    let target = wikilink::resolve_name(&link.target);
                    match type_by_name.get(&normalize(target)) {
                        Some(target_type) if target_type != "reference" => {
                            findings.push(Finding {
                                rule: self.name(),
                                severity: self.default_severity(),
                                file: card.path.clone(),
                                message: format!(
                                    "card '{}' cites '{}' (type '{}') in its reference field; only type 'reference' entries qualify",
                                    card.name, target, target_type
                                ),
                                data: Some(serde_json::json!({
                                    "target": target,
                                    "target_type": target_type,
                                })),
                            });
                        }
                        // A target naming no entry at all is `broken-wikilink`'s
                        // to report, now that it covers frontmatter links.
                        // Reporting it here too would earn one defect an Error
                        // and a Warn.
                        _ => {}
                    }
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

    fn vault_file(name: &str, entry_type: &str, folder: &str) -> crate::vault::VaultFile {
        let mut fm = BTreeMap::new();
        fm.insert("type".to_string(), Value::String(entry_type.to_string()));
        crate::vault::VaultFile {
            name: name.to_string(),
            path: PathBuf::from(format!("/vault/{}/{}.md", folder, name)),
            frontmatter: fm,
            ..Default::default()
        }
    }

    fn card_citing(name: &str, reference: Value) -> crate::vault::VaultFile {
        let mut file = vault_file(name, "card", "20 cards");
        file.frontmatter.insert("reference".to_string(), reference);
        file
    }

    fn run(files: Vec<crate::vault::VaultFile>) -> Vec<Finding> {
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);
        ReferenceWrongType.check(&ctx)
    }

    #[test]
    fn card_citing_reference_entry_emits_nothing() {
        let files = vec![
            vault_file("Foo", "reference", "10 references"),
            card_citing("Card", Value::String("[[10 references/Foo]]".to_string())),
        ];
        assert_eq!(run(files).len(), 0);
    }

    #[test]
    fn card_citing_note_emits_finding() {
        let files = vec![
            vault_file("Foo", "note", "30 notes"),
            card_citing("Card", Value::String("[[30 notes/Foo]]".to_string())),
        ];
        let findings = run(files);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, "reference-wrong-type");
        assert!(findings[0].message.contains("type 'note'"));
    }

    #[test]
    fn card_citing_card_emits_finding() {
        let files = vec![
            vault_file("Foo", "card", "20 cards"),
            card_citing("Card", Value::String("[[Foo]]".to_string())),
        ];
        assert_eq!(run(files).len(), 1);
    }

    #[test]
    fn dangling_reference_target_emits_exactly_one_finding() {
        // A `reference:` naming no entry is one defect. `broken-wikilink` now
        // covers frontmatter links, so this rule stays silent rather than
        // adding a second report of the same thing.
        let content = "---\ntype: card\nreference: \"[[Nowhere]]\"\n---\nBody.";
        let card = crate::vault::VaultFile {
            name: "Card".to_string(),
            path: PathBuf::from("/vault/20 cards/Card.md"),
            frontmatter: crate::frontmatter::parse(content).unwrap().unwrap(),
            content: content.to_string(),
            ..Default::default()
        };
        let files = vec![card];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        assert!(
            ReferenceWrongType.check(&ctx).is_empty(),
            "an unresolved target is broken-wikilink's to report"
        );
        let broken = crate::commands::lint::rules::broken_wikilink::BrokenWikilink.check(&ctx);
        assert_eq!(broken.len(), 1);
        assert_eq!(broken[0].data.as_ref().unwrap()["target"], "Nowhere");
    }

    #[test]
    fn list_reference_flags_only_wrong_typed_targets() {
        let files = vec![
            vault_file("Good", "reference", "10 references"),
            vault_file("Bad", "note", "30 notes"),
            card_citing(
                "Card",
                Value::Sequence(vec![
                    Value::String("[[Good]]".to_string()),
                    Value::String("[[Bad]]".to_string()),
                ]),
            ),
        ];
        let findings = run(files);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].data.as_ref().unwrap()["target"], "Bad");
    }

    #[test]
    fn alias_in_wikilink_resolves_target_not_alias() {
        let files = vec![
            vault_file("Foo", "note", "30 notes"),
            card_citing(
                "Card",
                Value::String("[[30 notes/Foo|Pretty Alias]]".to_string()),
            ),
        ];
        assert_eq!(run(files).len(), 1);
    }
}
