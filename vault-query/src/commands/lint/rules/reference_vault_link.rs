use std::collections::HashSet;

use crate::commands::lint::rule::{Finding, LintContext, Rule, Severity};
use crate::wikilink;
use crate::wikilink::normalize;

pub struct ReferenceVaultLink;

impl Rule for ReferenceVaultLink {
    fn name(&self) -> &'static str {
        "reference-vault-link"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warn
    }

    fn check(&self, ctx: &LintContext) -> Vec<Finding> {
        let known: HashSet<String> = ctx.files.iter().map(|f| normalize(&f.name)).collect();

        let mut findings = Vec::new();
        for (file, links) in ctx.files.iter().zip(&ctx.body_links) {
            let type_val = crate::frontmatter::get_display(&file.frontmatter, "type");
            if type_val != "reference" {
                continue;
            }
            let mut seen: HashSet<String> = HashSet::new();
            for link in links {
                let resolved = normalize(wikilink::resolve_name(&link.target));
                // Asset embeds and unresolved targets are out of scope: assets
                // are not entries, and broken targets are broken-wikilink's.
                if !known.contains(&resolved) {
                    continue;
                }
                if !seen.insert(resolved) {
                    continue;
                }
                findings.push(Finding {
                    rule: self.name(),
                    severity: self.default_severity(),
                    file: file.path.clone(),
                    message: format!(
                        "reference '{}' links to vault entry '{}'; a reference points outward only — move the analysis to a card or note",
                        file.name, link.target
                    ),
                    data: Some(serde_json::json!({ "target": link.target, "line": link.line })),
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

    fn typed_file(name: &str, entry_type: &str, content: &str) -> crate::vault::VaultFile {
        let mut fm = BTreeMap::new();
        fm.insert("type".to_string(), Value::String(entry_type.to_string()));
        crate::vault::VaultFile {
            name: name.to_string(),
            path: PathBuf::from(format!("/vault/{}.md", name)),
            frontmatter: fm,
            content: content.to_string(),
            ..Default::default()
        }
    }

    fn run(files: Vec<crate::vault::VaultFile>) -> Vec<Finding> {
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);
        ReferenceVaultLink.check(&ctx)
    }

    #[test]
    fn reference_without_links_emits_nothing() {
        let files = vec![typed_file("Ref", "reference", "Just an external URL.")];
        assert_eq!(run(files).len(), 0);
    }

    #[test]
    fn reference_linking_to_entry_emits_finding() {
        let files = vec![
            typed_file("Card", "card", ""),
            typed_file("Ref", "reference", "See [[Card]]."),
        ];
        let findings = run(files);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, "reference-vault-link");
        assert_eq!(findings[0].data.as_ref().unwrap()["target"], "Card");
    }

    #[test]
    fn note_linking_to_entry_emits_nothing() {
        let files = vec![
            typed_file("Card", "card", ""),
            typed_file("Note", "note", "See [[Card]]."),
        ];
        assert_eq!(run(files).len(), 0);
    }

    #[test]
    fn unresolved_target_is_left_to_broken_wikilink() {
        let files = vec![typed_file("Ref", "reference", "[[Nowhere]]")];
        assert_eq!(run(files).len(), 0);
    }

    #[test]
    fn duplicate_target_dedups_within_one_reference() {
        let files = vec![
            typed_file("Card", "card", ""),
            typed_file("Ref", "reference", "[[Card]] and [[Card]] again"),
        ];
        assert_eq!(run(files).len(), 1);
    }

    #[test]
    fn path_qualified_and_alias_forms_resolve() {
        let files = vec![
            typed_file("Card", "card", ""),
            typed_file("Ref", "reference", "[[20 cards/Card|alias]]"),
        ];
        assert_eq!(run(files).len(), 1);
    }
}
