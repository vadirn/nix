use std::collections::HashSet;

use crate::commands::lint::rule::{Finding, LintContext, Rule, Severity};

/// Flags `[[...]]` wikilinks in the body of a `type: ticket` file.
///
/// A ticket publishes to a reader who has only the git repo, so a vault
/// wikilink in the body resolves to nothing for them — the rationale has to
/// be restated inline, or the ticket has to name a repo artifact (file,
/// commit, symbol) the reader can resolve instead.
///
/// Ticket frontmatter is the opposite case: `track:`, `requires:`, and
/// `project:` are wikilinks by design and must never be flagged. No explicit
/// exemption is needed for them here — `ctx.body_links` is built from
/// `wikilink::extract`, which parses via `mdstruct` and never emits a
/// wikilink node for text inside the leading YAML frontmatter block, so
/// frontmatter wikilinks are already outside this rule's view.
pub struct TicketOutwardOnly;

impl Rule for TicketOutwardOnly {
    fn name(&self) -> &'static str {
        "ticket-outward-only"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warn
    }

    fn check(&self, ctx: &LintContext) -> Vec<Finding> {
        let mut findings = Vec::new();
        for (file, links) in ctx.files.iter().zip(&ctx.body_links) {
            let type_val = crate::frontmatter::get_display(&file.frontmatter, "type");
            if type_val != "ticket" {
                continue;
            }
            let mut seen: HashSet<String> = HashSet::new();
            for link in links {
                if !seen.insert(link.target.clone()) {
                    continue;
                }
                findings.push(Finding {
                    rule: self.name(),
                    severity: self.default_severity(),
                    file: file.path.clone(),
                    message: format!(
                        "ticket '{}' links to vault entry '{}'; a ticket body must be repo-self-sufficient — restate the referenced material inline, or name a file, commit, or symbol the reader can resolve",
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

    fn run(files: Vec<crate::vault::VaultFile>) -> Vec<Finding> {
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);
        TicketOutwardOnly.check(&ctx)
    }

    #[test]
    fn ticket_without_links_emits_nothing() {
        let files = vec![make_file(
            "ticket-foo",
            "/vault/41 projects/p/ticket-foo.md",
            "ticket",
            "Plain body text, no links.",
            false,
        )];
        assert!(run(files).is_empty());
    }

    #[test]
    fn ticket_body_wikilink_fires() {
        let files = vec![make_file(
            "ticket-foo",
            "/vault/41 projects/p/ticket-foo.md",
            "ticket",
            "See [[Card]] for background.",
            false,
        )];
        let findings = run(files);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, "ticket-outward-only");
        assert_eq!(findings[0].severity, Severity::Warn);
        assert_eq!(findings[0].data.as_ref().unwrap()["target"], "Card");
        assert!(
            findings[0].message.contains("ticket 'ticket-foo'")
                && findings[0].message.contains("vault entry 'Card'"),
            "unexpected message: {}",
            findings[0].message
        );
    }

    #[test]
    fn non_ticket_with_body_wikilink_emits_nothing() {
        let files = vec![make_file(
            "Card",
            "/vault/20 cards/Card.md",
            "card",
            "See [[Other]].",
            false,
        )];
        assert!(run(files).is_empty());
    }

    #[test]
    fn duplicate_target_dedups_within_one_ticket() {
        let files = vec![make_file(
            "ticket-foo",
            "/vault/41 projects/p/ticket-foo.md",
            "ticket",
            "[[Card]] and [[Card]] again",
            false,
        )];
        assert_eq!(run(files).len(), 1);
    }

    #[test]
    fn ticket_frontmatter_links_stay_exempt() {
        // Real frontmatter, wikilinks in track/requires/project, clean body —
        // proves the exemption end to end, not just via a hand-built
        // frontmatter map bypassing the real YAML block.
        let content = "---\n\
                        type: ticket\n\
                        track: \"[[Track]]\"\n\
                        requires:\n  \
                          - \"[[Other]]\"\n\
                        project: \"[[Project]]\"\n\
                        ---\n\
                        Body with no links, just prose.";
        let mut fm = BTreeMap::new();
        fm.insert("type".to_string(), Value::String("ticket".to_string()));
        let files = vec![crate::vault::VaultFile {
            name: "ticket-clean".to_string(),
            path: PathBuf::from("/vault/41 projects/p/ticket-clean.md"),
            frontmatter: fm,
            content: content.to_string(),
            ..Default::default()
        }];
        assert!(run(files).is_empty());
    }

    #[test]
    fn template_ticket_still_fires() {
        // Mirrors reference-vault-link: that rule grants no template
        // exemption, so neither does this one.
        let files = vec![make_file(
            "TicketTemplate",
            "/vault/templates/ticket.md",
            "ticket",
            "See [[Card]].",
            true,
        )];
        assert_eq!(run(files).len(), 1);
    }
}
