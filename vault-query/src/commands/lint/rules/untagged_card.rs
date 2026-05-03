use crate::commands::lint::rule::{Category, Finding, LintContext, Rule, Severity};
use crate::frontmatter;

pub struct UntaggedCard;

impl Rule for UntaggedCard {
    fn name(&self) -> &'static str {
        "untagged-card"
    }

    fn category(&self) -> Category {
        Category::Structural
    }

    fn default_severity(&self) -> Severity {
        Severity::Warn
    }

    fn check(&self, ctx: &LintContext) -> Vec<Finding> {
        let mut findings = Vec::new();
        for card in &ctx.cards {
            if frontmatter::get_seq_len(&card.frontmatter, "tags") == 0 {
                findings.push(Finding {
                    rule: self.name(),
                    severity: self.default_severity(),
                    file: card.path.clone(),
                    message: format!("card '{}' has no tags", card.name),
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

    fn card_file(name: &str, path: &str) -> crate::vault::VaultFile {
        let mut fm = BTreeMap::new();
        fm.insert("type".to_string(), Value::String("card".to_string()));
        crate::vault::VaultFile {
            name: name.to_string(),
            path: PathBuf::from(path),
            frontmatter: fm,
            ..Default::default()
        }
    }

    fn card_with_tags(name: &str, path: &str, tags: Vec<Value>) -> crate::vault::VaultFile {
        let mut fm = BTreeMap::new();
        fm.insert("type".to_string(), Value::String("card".to_string()));
        fm.insert("tags".to_string(), Value::Sequence(tags));
        crate::vault::VaultFile {
            name: name.to_string(),
            path: PathBuf::from(path),
            frontmatter: fm,
            ..Default::default()
        }
    }

    fn typed_file(name: &str, path: &str, file_type: &str) -> crate::vault::VaultFile {
        let mut fm = BTreeMap::new();
        fm.insert("type".to_string(), Value::String(file_type.to_string()));
        crate::vault::VaultFile {
            name: name.to_string(),
            path: PathBuf::from(path),
            frontmatter: fm,
            ..Default::default()
        }
    }

    #[test]
    fn untagged_card_missing_tags_key_emits_finding() {
        // card frontmatter has `type: card` only — no `tags` key at all
        let card = card_file("Foo", "/vault/20 cards/Foo.md");
        let files = vec![card];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files);

        let findings = UntaggedCard.check(&ctx);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, "untagged-card");
        assert_eq!(findings[0].file, PathBuf::from("/vault/20 cards/Foo.md"));
        assert_eq!(findings[0].message, "card 'Foo' has no tags");
    }

    #[test]
    fn untagged_card_empty_tags_list_emits_finding() {
        // card with `tags: []`
        let card = card_with_tags("Bar", "/vault/20 cards/Bar.md", vec![]);
        let files = vec![card];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files);

        let findings = UntaggedCard.check(&ctx);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, "untagged-card");
        assert_eq!(findings[0].file, PathBuf::from("/vault/20 cards/Bar.md"));
    }

    #[test]
    fn tagged_card_emits_nothing() {
        // card with `tags: [foo]`
        let card = card_with_tags(
            "Baz",
            "/vault/20 cards/Baz.md",
            vec![Value::String("foo".into())],
        );
        let files = vec![card];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files);

        let findings = UntaggedCard.check(&ctx);
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn untagged_reference_emits_nothing() {
        // `type: reference` file with no tags — only cards are subject to this rule
        let reference = typed_file("RefOne", "/vault/10 references/RefOne.md", "reference");
        let files = vec![reference];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files);

        let findings = UntaggedCard.check(&ctx);
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn untagged_card_tags_is_scalar_emits_finding() {
        // Defensive: `tags: "foo"` is a scalar, not a sequence.
        // `get_seq_len` returns 0 for any non-Sequence value (see frontmatter.rs line 126),
        // so this is treated as having no tags.
        let mut fm = BTreeMap::new();
        fm.insert("type".to_string(), Value::String("card".to_string()));
        fm.insert("tags".to_string(), Value::String("foo".into()));
        let card = crate::vault::VaultFile {
            name: "ScalarTagCard".to_string(),
            path: PathBuf::from("/vault/20 cards/ScalarTagCard.md"),
            frontmatter: fm,
            ..Default::default()
        };
        let files = vec![card];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files);

        let findings = UntaggedCard.check(&ctx);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, "untagged-card");
        assert_eq!(
            findings[0].file,
            PathBuf::from("/vault/20 cards/ScalarTagCard.md")
        );
    }

    #[test]
    fn multiple_untagged_cards_each_get_a_finding() {
        let card_a = card_file("Alpha", "/vault/20 cards/Alpha.md");
        let card_b = card_file("Beta", "/vault/20 cards/Beta.md");
        let files = vec![card_a, card_b];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files);

        let findings = UntaggedCard.check(&ctx);
        assert_eq!(findings.len(), 2);

        let rules: Vec<&str> = findings.iter().map(|f| f.rule).collect();
        assert!(rules.iter().all(|&r| r == "untagged-card"));

        let paths: Vec<&PathBuf> = findings.iter().map(|f| &f.file).collect();
        assert!(paths.contains(&&PathBuf::from("/vault/20 cards/Alpha.md")));
        assert!(paths.contains(&&PathBuf::from("/vault/20 cards/Beta.md")));
    }
}
