use crate::commands::lint::rule::{Finding, LintContext, Rule, Severity};
use crate::frontmatter;

/// Flags knowledge docs whose body exceeds the consult per-doc token cap.
///
/// An oversized card/note/experiment can never be inlined by `consult` (the
/// packer skips it whole and emits a pointer instead), and a large body hurts
/// retrieval precision even below the cap.  The threshold is
/// `ConsultConfig.per_doc_token_cap` — the same value the packer enforces —
/// plumbed in through `built_in_rules(cap)` so lint and consult cannot drift.
///
/// Scope: the knowledge types consult inlines (card, note, experiment).
/// References are bookmarks, tracks/checkpoints are append-mostly project
/// memory — all exempt, as are templates.
pub struct OversizedEntry {
    pub per_doc_token_cap: usize,
}

const CHECKED_TYPES: [&str; 3] = ["card", "note", "experiment"];

impl Rule for OversizedEntry {
    fn name(&self) -> &'static str {
        "oversized-entry"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warn
    }

    fn check(&self, ctx: &LintContext) -> Vec<Finding> {
        let mut findings = Vec::new();

        for file in ctx.files {
            if frontmatter::is_template(&file.frontmatter) {
                continue;
            }

            let type_val = frontmatter::get_display(&file.frontmatter, "type");
            if !CHECKED_TYPES.contains(&type_val.as_str()) {
                continue;
            }

            // Same estimate the consult packer applies to the body it would inline.
            let tokens_est = crate::tokens::estimate_tokens(frontmatter::body(&file.content));
            if tokens_est > self.per_doc_token_cap {
                findings.push(Finding {
                    rule: self.name(),
                    severity: self.default_severity(),
                    file: file.path.clone(),
                    message: format!(
                        "{} '{}' body ~{} est tokens exceeds consult per-doc cap ({}); \
                         split by concept or distill",
                        type_val, file.name, tokens_est, self.per_doc_token_cap
                    ),
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

    /// Build a VaultFile whose `content` carries real frontmatter plus `body`.
    fn make_file(
        name: &str,
        path: &str,
        type_val: &str,
        body: &str,
        is_template: bool,
    ) -> crate::vault::VaultFile {
        let template_line = if is_template { "template: true\n" } else { "" };
        let content = format!("---\ntype: {type_val}\n{template_line}---\n{body}");

        let mut fm = BTreeMap::new();
        fm.insert("type".to_string(), Value::String(type_val.to_string()));
        if is_template {
            fm.insert("template".to_string(), Value::Bool(true));
        }
        crate::vault::VaultFile {
            name: name.to_string(),
            path: PathBuf::from(path),
            frontmatter: fm,
            content,
            ..Default::default()
        }
    }

    fn check_with_cap(files: Vec<crate::vault::VaultFile>, cap: usize) -> Vec<Finding> {
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);
        OversizedEntry { per_doc_token_cap: cap }.check(&ctx)
    }

    // 50 reps × 10 chars = 500 chars → ~125 est tokens.
    fn big_body() -> String {
        "0123456789".repeat(50)
    }

    #[test]
    fn oversized_card_fires() {
        let files = vec![make_file(
            "BigCard",
            "/vault/20 cards/BigCard.md",
            "card",
            &big_body(),
            false,
        )];
        let findings = check_with_cap(files, 100);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, "oversized-entry");
        assert_eq!(findings[0].severity, Severity::Warn);
        assert!(
            findings[0].message.contains("card 'BigCard'")
                && findings[0].message.contains("exceeds consult per-doc cap (100)"),
            "unexpected message: {}",
            findings[0].message
        );
    }

    #[test]
    fn small_card_is_silent() {
        let files = vec![make_file(
            "SmallCard",
            "/vault/20 cards/SmallCard.md",
            "card",
            "a short body",
            false,
        )];
        assert!(check_with_cap(files, 100).is_empty());
    }

    #[test]
    fn oversized_reference_is_exempt() {
        let files = vec![make_file(
            "BigRef",
            "/vault/10 references/BigRef.md",
            "reference",
            &big_body(),
            false,
        )];
        assert!(check_with_cap(files, 100).is_empty());
    }

    #[test]
    fn oversized_track_is_exempt() {
        let files = vec![make_file(
            "track-foo",
            "/vault/41 projects/p/track-foo.md",
            "track",
            &big_body(),
            false,
        )];
        assert!(check_with_cap(files, 100).is_empty());
    }

    #[test]
    fn oversized_template_is_exempt() {
        let files = vec![make_file(
            "CardTemplate",
            "/vault/templates/card.md",
            "card",
            &big_body(),
            true,
        )];
        assert!(check_with_cap(files, 100).is_empty());
    }

    #[test]
    fn custom_cap_is_respected() {
        // ~125 est tokens: fires under a 100-token cap, silent under 200.
        let files = vec![make_file(
            "Card",
            "/vault/20 cards/Card.md",
            "note",
            &big_body(),
            false,
        )];
        assert_eq!(check_with_cap(files.clone(), 100).len(), 1);
        assert!(check_with_cap(files, 200).is_empty());
    }
}
