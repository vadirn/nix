use std::collections::HashSet;

use crate::commands::lint::rule::{Finding, LintContext, Rule, Severity};

/// Flags a `[[...]]` written unquoted in YAML frontmatter, where YAML reads it
/// as a nested sequence and the link stops existing.
///
/// `key: [[X]]` is not a string. The outer `[` opens a flow sequence whose one
/// element is another flow sequence whose one element is the plain scalar `X`,
/// so the parsed value is `Sequence([Sequence([String("X")])])`. Every consumer
/// that recovers links from string scalars — the backlink index,
/// `broken-wikilink`, `reference-wrong-type`, `dangling-requires-target` — then
/// sees `X`, finds no `[[` in it, and reports nothing. The author wrote a link,
/// the vault holds an array, and no rule fires. That silence is the defect this
/// rule exists to break.
///
/// It is a quoting fault, not a resolution fault: the target it names may well
/// exist. So it carries its own message and its own severity rather than
/// joining `broken-wikilink`, and quoting the value is the whole fix.
///
/// Detection is a discrepancy between two readings of the same block, supplied
/// by `wikilink::frontmatter_links`: a `[[...]]` present in the raw frontmatter
/// text that the parse did not yield as a string scalar, and whose bracketed
/// text does appear as the sole element of some sequence in the parsed tree.
/// The second condition is what spares a genuine nested array — `key: [[a, b]]`
/// leaves a two-element inner sequence, never a one-element one, so it is not
/// mistaken for a link an author fumbled.
pub struct UnquotedFrontmatterLink;

impl Rule for UnquotedFrontmatterLink {
    fn name(&self) -> &'static str {
        "unquoted-frontmatter-link"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warn
    }

    fn check(&self, ctx: &LintContext) -> Vec<Finding> {
        let mut findings = Vec::new();
        for (file, links) in ctx.files.iter().zip(&ctx.frontmatter_links) {
            let mut seen: HashSet<String> = HashSet::new();
            for link in &links.unquoted {
                let text = match &link.alias {
                    Some(alias) => format!("{}|{}", link.target, alias),
                    None => link.target.clone(),
                };
                if !seen.insert(text.clone()) {
                    continue;
                }
                findings.push(Finding {
                    rule: self.name(),
                    severity: self.default_severity(),
                    file: file.path.clone(),
                    message: format!(
                        "frontmatter `[[{text}]]` is unquoted, so YAML reads it as a nested sequence and the link disappears; write it as \"[[{text}]]\""
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
    use crate::commands::lint::rules::broken_wikilink::BrokenWikilink;
    use std::path::PathBuf;

    fn fm_file(name: &str, path: &str, frontmatter_lines: &str) -> crate::vault::VaultFile {
        let content = format!("---\n{frontmatter_lines}---\nBody.");
        let fm = crate::frontmatter::parse(&content).unwrap().unwrap();
        crate::vault::VaultFile {
            name: name.to_string(),
            path: PathBuf::from(path),
            frontmatter: fm,
            content,
            ..Default::default()
        }
    }

    fn run(files: &[crate::vault::VaultFile]) -> Vec<Finding> {
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, files, &[]);
        UnquotedFrontmatterLink.check(&ctx)
    }

    #[test]
    fn unquoted_link_emits_the_quoting_finding_and_no_broken_link_finding() {
        let files = vec![fm_file(
            "Src",
            "/vault/Src.md",
            "type: ticket\nproject: [[X]]\n",
        )];
        let findings = run(&files);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, "unquoted-frontmatter-link");
        assert_eq!(findings[0].severity, Severity::Warn);
        assert_eq!(findings[0].data.as_ref().unwrap()["target"], "X");
        assert_eq!(findings[0].data.as_ref().unwrap()["line"], 3);

        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);
        assert!(
            BrokenWikilink.check(&ctx).is_empty(),
            "an unquoted link is a quoting defect, not a resolution one"
        );
    }

    #[test]
    fn unquoted_link_fires_even_when_the_target_exists() {
        // The target resolving is beside the point: quoted or not decides
        // whether the link exists at all.
        let files = vec![
            fm_file("X", "/vault/X.md", "type: note\n"),
            fm_file("Src", "/vault/Src.md", "type: ticket\nproject: [[X]]\n"),
        ];
        assert_eq!(run(&files).len(), 1);
    }

    #[test]
    fn nested_array_emits_nothing_from_either_rule() {
        // `[[a, b]]` is a real two-element nested array, shaped like an
        // unquoted link in the raw text but not one in the parse.
        let files = vec![fm_file(
            "Src",
            "/vault/Src.md",
            "type: note\nmatrix: [[a, b]]\n",
        )];
        assert!(run(&files).is_empty());

        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);
        assert!(BrokenWikilink.check(&ctx).is_empty());
    }

    #[test]
    fn quoted_link_emits_nothing() {
        let files = vec![fm_file(
            "Src",
            "/vault/Src.md",
            "type: ticket\nproject: \"[[X]]\"\n",
        )];
        assert!(run(&files).is_empty());
    }

    #[test]
    fn unquoted_link_inside_a_sequence_is_flagged() {
        let files = vec![fm_file(
            "Src",
            "/vault/Src.md",
            "type: ticket\nrequires:\n  - \"[[ticket-a]]\"\n  - [[ticket-b]]\n",
        )];
        let findings = run(&files);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].data.as_ref().unwrap()["target"], "ticket-b");
        assert_eq!(findings[0].data.as_ref().unwrap()["line"], 5);
    }

    #[test]
    fn alias_form_is_reported_verbatim() {
        let files = vec![fm_file(
            "Src",
            "/vault/Src.md",
            "type: ticket\nproject: [[X|Alias]]\n",
        )];
        let findings = run(&files);
        assert_eq!(findings.len(), 1);
        assert!(
            findings[0].message.contains("[[X|Alias]]"),
            "unexpected message: {}",
            findings[0].message
        );
        assert_eq!(findings[0].data.as_ref().unwrap()["target"], "X");
    }

    #[test]
    fn body_wikilink_is_not_this_rule_s_business() {
        let files = vec![fm_file("Src", "/vault/Src.md", "type: note\n")];
        assert!(run(&files).is_empty());
    }

    #[test]
    fn default_severity_is_warn() {
        assert_eq!(UnquotedFrontmatterLink.default_severity(), Severity::Warn);
    }
}
