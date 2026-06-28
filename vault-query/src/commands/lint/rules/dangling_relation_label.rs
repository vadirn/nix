use crate::commands::lint::relations::Endpoint;
use crate::commands::lint::rule::{Finding, LintContext, Rule, Severity};

/// `dangling-relation-label` — a hard correctness lint (D29/D32). A bare LOCAL
/// relation endpoint, or a from-label, that matches no local node — no `## Glossary`
/// term and no `## Workflow` step in the same file — is an unanchored edge. The
/// label is slugged before lookup (BUILD pre-slugs, but a hand-authored label may
/// not), so resolution is the same slug space the node set is built in.
///
/// File endpoints (`[[file-slug]]`) are out of scope: a cross-file target is a real
/// wikilink that `broken-wikilink` already validates, not a local node.
pub struct DanglingRelationLabel;

impl Rule for DanglingRelationLabel {
    fn name(&self) -> &'static str {
        "dangling-relation-label"
    }

    fn default_severity(&self) -> Severity {
        Severity::Error
    }

    fn check(&self, ctx: &LintContext) -> Vec<Finding> {
        let mut findings = Vec::new();
        for ((file, edges), nodes) in ctx
            .files
            .iter()
            .zip(&ctx.relations)
            .zip(&ctx.local_nodes)
        {
            for edge in edges {
                // A from-label, when present (multi-node note, D26), is itself a
                // local node label.
                if let Some(from) = &edge.from_label {
                    if !nodes.contains(&crate::slug::segment(from)) {
                        findings.push(self.finding(file, from, "from-label", edge.line));
                    }
                }
                // A bare local endpoint must resolve to a local node; a `[[file]]`
                // endpoint is broken-wikilink's concern, not this rule's.
                if let Endpoint::Local(label) = &edge.endpoint {
                    if !nodes.contains(&crate::slug::segment(label)) {
                        findings.push(self.finding(file, label, "endpoint", edge.line));
                    }
                }
            }
        }
        findings
    }
}

impl DanglingRelationLabel {
    fn finding(
        &self,
        file: &crate::vault::VaultFile,
        label: &str,
        position: &str,
        line: usize,
    ) -> Finding {
        Finding {
            rule: self.name(),
            severity: self.default_severity(),
            file: file.path.clone(),
            message: format!(
                "relation {} '{}' matches no local Glossary term or Workflow step",
                position, label
            ),
            data: Some(serde_json::json!({
                "label": label,
                "position": position,
                "line": line,
            })),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::lint::rule::LintContext;
    use std::path::PathBuf;

    fn file_with(content: &str) -> crate::vault::VaultFile {
        crate::vault::VaultFile {
            name: "Note".to_string(),
            path: PathBuf::from("/vault/Note.md"),
            content: content.to_string(),
            ..Default::default()
        }
    }

    /// A note whose every bare endpoint and from-label resolves to a local node.
    const RESOLVED: &str = "## Glossary\n\n| Term | Def |\n| ---- | --- |\n| Aim point | x |\n| Holdover | y |\n\n## Relations\n\n- aim-point subsumes:: holdover\n";

    #[test]
    fn all_local_labels_resolve_emits_nothing() {
        let files = vec![file_with(RESOLVED)];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);
        assert!(DanglingRelationLabel.check(&ctx).is_empty());
    }

    #[test]
    fn dangling_endpoint_emits_finding() {
        // `windage` is no Glossary term / Workflow step.
        let md = "## Glossary\n\n| Term | Def |\n| ---- | --- |\n| Aim point | x |\n\n## Relations\n\n- aim-point subsumes:: windage\n";
        let files = vec![file_with(md)];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = DanglingRelationLabel.check(&ctx);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, "dangling-relation-label");
        let data = findings[0].data.as_ref().unwrap();
        assert_eq!(data["label"], "windage");
        assert_eq!(data["position"], "endpoint");
        assert_eq!(data["line"], 9);
    }

    #[test]
    fn dangling_from_label_emits_finding() {
        // `phantom` is no local node; the endpoint `aim-point` resolves.
        let md = "## Glossary\n\n| Term | Def |\n| ---- | --- |\n| Aim point | x |\n\n## Relations\n\n- phantom subsumes:: aim-point\n";
        let files = vec![file_with(md)];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = DanglingRelationLabel.check(&ctx);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].data.as_ref().unwrap()["position"], "from-label");
        assert_eq!(findings[0].data.as_ref().unwrap()["label"], "phantom");
    }

    #[test]
    fn file_endpoint_is_out_of_scope() {
        // A `[[file]]` endpoint that names no local node must NOT be flagged here.
        let md = "## Glossary\n\n| Term | Def |\n| ---- | --- |\n| Aim point | x |\n\n## Relations\n\n- aim-point contrast-to:: [[some-other-note]]\n";
        let files = vec![file_with(md)];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);
        assert!(DanglingRelationLabel.check(&ctx).is_empty());
    }

    #[test]
    fn workflow_step_resolves_an_endpoint() {
        // A bare endpoint pointing at a Workflow step-slug resolves.
        let md = "## Workflow\n\n1. Range the target\n\n## Glossary\n\n| Term | Def |\n| ---- | --- |\n| Aim point | x |\n\n## Relations\n\n- aim-point precondition-for:: range-the-target\n";
        let files = vec![file_with(md)];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);
        assert!(DanglingRelationLabel.check(&ctx).is_empty());
    }

    #[test]
    fn dangling_label_on_golden_node_fixture() {
        // The shared node fixture carries exactly one dangling endpoint (`windage`).
        let fixture = include_str!("../../../../tests/fixtures/node-roundtrip.md");
        let files = vec![file_with(fixture)];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = DanglingRelationLabel.check(&ctx);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].data.as_ref().unwrap()["label"], "windage");
    }

    #[test]
    fn default_severity_is_error() {
        assert_eq!(DanglingRelationLabel.default_severity(), Severity::Error);
    }
}
