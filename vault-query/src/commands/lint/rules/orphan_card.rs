use crate::commands::lint::rule::{Finding, LintContext, Rule, Severity};
use crate::{epistemic, wikilink};

pub struct OrphanCard;

impl Rule for OrphanCard {
    fn name(&self) -> &'static str {
        "orphan-card"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warn
    }

    fn check(&self, ctx: &LintContext) -> Vec<Finding> {
        let mut findings = Vec::new();
        for card in &ctx.cards {
            if epistemic::is_lint_exempt(&card.frontmatter) {
                continue;
            }
            if is_folder_index(card) {
                continue;
            }
            // Key the lookup through the same canonical join key the index is built
            // with, so a card and its incoming links collapse to one key.
            let key = wikilink::backlink_key(&card.name);
            if !ctx.backlink_index.contains_key(&key) {
                findings.push(Finding {
                    rule: self.name(),
                    severity: self.default_severity(),
                    file: card.path.clone(),
                    message: format!("card '{}' has no inbound wikilinks", card.name),
                    data: None,
                });
            }
        }
        findings
    }
}

fn is_folder_index(card: &crate::vault::VaultFile) -> bool {
    let Some(stem) = card.name.strip_prefix('~') else {
        return false;
    };
    let Some(parent) = card
        .path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|s| s.to_str())
    else {
        return false;
    };
    parent == stem
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

    fn reference_file(name: &str, path: &str) -> crate::vault::VaultFile {
        let mut fm = BTreeMap::new();
        fm.insert("type".to_string(), Value::String("reference".to_string()));
        crate::vault::VaultFile {
            name: name.to_string(),
            path: PathBuf::from(path),
            frontmatter: fm,
            ..Default::default()
        }
    }

    fn linker_file(name: &str, links_to: &str) -> crate::vault::VaultFile {
        crate::vault::VaultFile {
            name: name.to_string(),
            content: format!("[[{}]]", links_to),
            ..Default::default()
        }
    }

    #[test]
    fn orphan_card_with_no_backlinks_emits_finding() {
        let card = card_file("Foo", "/vault/20 cards/Foo.md");
        let files = vec![card];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = OrphanCard.check(&ctx);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, "orphan-card");
        assert_eq!(findings[0].file, PathBuf::from("/vault/20 cards/Foo.md"));
    }

    #[test]
    fn orphan_card_with_inbound_link_emits_nothing() {
        let card = card_file("Foo", "/vault/20 cards/Foo.md");
        let linker = linker_file("Bar", "Foo");
        let files = vec![card, linker];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = OrphanCard.check(&ctx);
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn non_card_with_no_backlinks_emits_nothing() {
        let reference = reference_file("OrphanRef", "/vault/10 references/OrphanRef.md");
        let files = vec![reference];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = OrphanCard.check(&ctx);
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn folder_index_card_emits_no_finding() {
        let card = card_file("~Foo", "/vault/20 cards/Foo/~Foo.md");
        let files = vec![card];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = OrphanCard.check(&ctx);
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn loose_tilde_card_without_matching_folder_still_emits_finding() {
        let card = card_file("~loose", "/vault/20 cards/~loose.md");
        let files = vec![card];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = OrphanCard.check(&ctx);
        assert_eq!(findings.len(), 1);
    }

    #[test]
    fn multiple_orphan_cards_each_get_a_finding() {
        let card_a = card_file("Alpha", "/vault/20 cards/Alpha.md");
        let card_b = card_file("Beta", "/vault/20 cards/Beta.md");
        let files = vec![card_a, card_b];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = OrphanCard.check(&ctx);
        assert_eq!(findings.len(), 2);

        let rules: Vec<&str> = findings.iter().map(|f| f.rule).collect();
        assert!(rules.iter().all(|&r| r == "orphan-card"));

        let paths: Vec<&PathBuf> = findings.iter().map(|f| &f.file).collect();
        assert!(paths.contains(&&PathBuf::from("/vault/20 cards/Alpha.md")));
        assert!(paths.contains(&&PathBuf::from("/vault/20 cards/Beta.md")));
    }

    fn superseded_card(name: &str, path: &str) -> crate::vault::VaultFile {
        let mut fm = BTreeMap::new();
        fm.insert("type".to_string(), Value::String("card".to_string()));
        fm.insert("superseded".to_string(), Value::Bool(true));
        crate::vault::VaultFile {
            name: name.to_string(),
            path: PathBuf::from(path),
            frontmatter: fm,
            ..Default::default()
        }
    }

    fn checkpoint_file(name: &str, path: &str) -> crate::vault::VaultFile {
        let mut fm = BTreeMap::new();
        fm.insert("type".to_string(), Value::String("checkpoint".to_string()));
        crate::vault::VaultFile {
            name: name.to_string(),
            path: PathBuf::from(path),
            frontmatter: fm,
            ..Default::default()
        }
    }

    #[test]
    fn superseded_card_with_no_backlinks_is_exempt() {
        let card = superseded_card("OldConcept", "/vault/20 cards/OldConcept.md");
        let files = vec![card];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = OrphanCard.check(&ctx);
        assert!(findings.is_empty(), "superseded card must not produce orphan-card finding");
    }

    #[test]
    fn checkpoint_with_no_backlinks_is_exempt() {
        let cp = checkpoint_file("checkpoint-001", "/vault/41 projects/nix/checkpoint-001.md");
        let files = vec![cp];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = OrphanCard.check(&ctx);
        assert!(findings.is_empty(), "checkpoint must not produce orphan-card finding");
    }
}
