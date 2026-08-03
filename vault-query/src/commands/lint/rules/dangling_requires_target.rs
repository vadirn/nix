use std::collections::HashSet;

use crate::commands::lint::rule::{Finding, LintContext, Rule, Severity};
use crate::wikilink;
use crate::wikilink::normalize;

/// Flags a `type: ticket` file's `requires:` entry that names no ticket file
/// in the vault.
///
/// `requires:` is the work model's dependency edge: a wikilink from a ticket
/// to the ticket(s) that must land first. Nothing else checks that the edge
/// resolves. `broken-wikilink` only scans body wikilinks (`ctx.body_links`,
/// built from `wikilink::extract(&file.content)`, which never sees inside the
/// YAML frontmatter block), and `ticket-outward-only` deliberately exempts
/// `requires:` as a frontmatter wikilink by design. A typo, a rename, or a
/// deleted ticket leaves `requires:` pointing at nothing with no signal
/// anywhere — a reader has no way to tell whether the named blocker is done,
/// renamed, or never existed.
///
/// Resolution mirrors `reference_wrong_type`'s frontmatter walk rather than
/// `commands::tickets::ticket_track_slug`'s single-value one:
/// `wikilink::walk_frontmatter_links` visits every entry of the `requires:`
/// sequence individually (not joined into one display string, so a multi-
/// entry list is checked in full, not just its first member), and
/// `wikilink::resolve_name` strips the folder prefix and `.md` suffix down to
/// a bare stem for comparison. The known set here is scoped to `type: ticket`
/// files only — `requires:` names a ticket specifically, so an entry
/// resolving to a same-named card or note is still a defect, not a pass.
/// Whether a resolved blocker is still open is a separate, status-level
/// question this rule does not answer.
pub struct DanglingRequiresTarget;

impl Rule for DanglingRequiresTarget {
    fn name(&self) -> &'static str {
        "dangling-requires-target"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warn
    }

    fn check(&self, ctx: &LintContext) -> Vec<Finding> {
        let ticket_stems: HashSet<String> = ctx
            .files
            .iter()
            .filter(|f| crate::frontmatter::get_display(&f.frontmatter, "type") == "ticket")
            .map(|f| normalize(&f.name))
            .collect();

        let mut findings = Vec::new();
        for file in ctx.files {
            let type_val = crate::frontmatter::get_display(&file.frontmatter, "type");
            if type_val != "ticket" {
                continue;
            }
            let Some(value) = file.frontmatter.get("requires") else {
                continue;
            };
            let mut seen: HashSet<String> = HashSet::new();
            wikilink::walk_frontmatter_links(value, &mut |link| {
                let stem = wikilink::resolve_name(&link.target);
                if ticket_stems.contains(&normalize(stem)) {
                    return;
                }
                if !seen.insert(link.target.clone()) {
                    return;
                }
                findings.push(Finding {
                    rule: self.name(),
                    severity: self.default_severity(),
                    file: file.path.clone(),
                    message: format!(
                        "ticket '{}' requires '{}', but no such ticket exists",
                        file.name, link.target
                    ),
                    data: Some(serde_json::json!({ "target": link.target })),
                });
            });
        }
        findings
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::lint::rule::LintContext;
    use std::path::PathBuf;

    /// Build a `VaultFile` whose `content` (and therefore `frontmatter`,
    /// parsed for real via `crate::frontmatter::parse`) carries `type:
    /// <type_val>` plus whatever frontmatter lines the caller supplies —
    /// typically a `requires:` sequence. Parsing real YAML rather than
    /// hand-building a `serde_yaml::Value` proves the rule against the same
    /// representation `LintContext::build` sees in production.
    fn make_file(
        name: &str,
        path: &str,
        type_val: &str,
        extra_frontmatter: &str,
    ) -> crate::vault::VaultFile {
        let content = format!("---\ntype: {type_val}\n{extra_frontmatter}---\nBody.");
        let fm = crate::frontmatter::parse(&content).unwrap().unwrap();
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
        DanglingRequiresTarget.check(&ctx)
    }

    #[test]
    fn entry_resolving_to_an_existing_ticket_emits_nothing() {
        let blocker = make_file(
            "ticket-foo",
            "/vault/41 projects/p/ticket-foo.md",
            "ticket",
            "",
        );
        let dependent = make_file(
            "ticket-bar",
            "/vault/41 projects/p/ticket-bar.md",
            "ticket",
            "requires:\n  - \"[[41 projects/p/ticket-foo]]\"\n",
        );
        assert!(run(vec![blocker, dependent]).is_empty());
    }

    #[test]
    fn entry_naming_a_nonexistent_ticket_emits_one_finding() {
        let dependent = make_file(
            "ticket-bar",
            "/vault/41 projects/p/ticket-bar.md",
            "ticket",
            "requires:\n  - \"[[41 projects/p/ticket-missing]]\"\n",
        );
        let findings = run(vec![dependent]);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, "dangling-requires-target");
        assert_eq!(findings[0].severity, Severity::Warn);
        assert_eq!(
            findings[0].data.as_ref().unwrap()["target"],
            "41 projects/p/ticket-missing"
        );
        assert!(
            findings[0].message.contains("ticket 'ticket-bar'")
                && findings[0].message.contains("41 projects/p/ticket-missing"),
            "unexpected message: {}",
            findings[0].message
        );
    }

    #[test]
    fn empty_requires_emits_nothing() {
        let ticket = make_file(
            "ticket-bar",
            "/vault/41 projects/p/ticket-bar.md",
            "ticket",
            "requires: []\n",
        );
        assert!(run(vec![ticket]).is_empty());
    }

    #[test]
    fn absent_requires_emits_nothing() {
        let ticket = make_file(
            "ticket-bar",
            "/vault/41 projects/p/ticket-bar.md",
            "ticket",
            "",
        );
        assert!(run(vec![ticket]).is_empty());
    }

    #[test]
    fn non_ticket_file_with_requires_is_ignored() {
        let note = make_file(
            "note-bar",
            "/vault/30 notes/note-bar.md",
            "note",
            "requires:\n  - \"[[41 projects/p/ticket-missing]]\"\n",
        );
        assert!(run(vec![note]).is_empty());
    }

    #[test]
    fn duplicate_missing_target_dedups_within_one_ticket() {
        let dependent = make_file(
            "ticket-bar",
            "/vault/41 projects/p/ticket-bar.md",
            "ticket",
            "requires:\n  - \"[[41 projects/p/ticket-missing]]\"\n  - \"[[41 projects/p/ticket-missing]]\"\n",
        );
        assert_eq!(run(vec![dependent]).len(), 1);
    }

    #[test]
    fn missing_target_among_a_mixed_sequence_is_flagged_once() {
        let blocker = make_file(
            "ticket-foo",
            "/vault/41 projects/p/ticket-foo.md",
            "ticket",
            "",
        );
        let dependent = make_file(
            "ticket-bar",
            "/vault/41 projects/p/ticket-bar.md",
            "ticket",
            "requires:\n  - \"[[41 projects/p/ticket-foo]]\"\n  - \"[[41 projects/p/ticket-missing]]\"\n",
        );
        let findings = run(vec![blocker, dependent]);
        assert_eq!(findings.len(), 1);
        assert_eq!(
            findings[0].data.as_ref().unwrap()["target"],
            "41 projects/p/ticket-missing"
        );
    }
}
