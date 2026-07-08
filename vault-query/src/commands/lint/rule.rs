use std::collections::HashMap;

// `Severity` now lives in `crate::config` (the foundation layer) to break the
// `config`↔`lint` import cycle. Re-exported here so the rule files keep
// addressing it as `crate::commands::lint::rule::Severity`.
pub use crate::config::Severity;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    pub rule: &'static str,
    pub severity: Severity,
    pub file: std::path::PathBuf,
    pub message: String,
    pub data: Option<serde_json::Value>,
}

pub trait Rule: Send + Sync {
    fn name(&self) -> &'static str;
    fn default_severity(&self) -> Severity;
    fn check(&self, ctx: &LintContext) -> Vec<Finding>;
}

pub struct LintContext<'a> {
    pub vault_root: &'a std::path::Path,
    pub files: &'a [crate::vault::VaultFile],
    pub assets: Vec<crate::vault::VaultAsset>,
    pub cards: Vec<&'a crate::vault::VaultFile>,
    pub references: Vec<&'a crate::vault::VaultFile>,
    /// Body wikilinks per file, parallel to `files`.  Extracted once here so
    /// rules reuse the parse instead of re-running it per rule.
    pub body_links: Vec<Vec<crate::wikilink::Wikilink>>,
    pub backlink_index: HashMap<String, Vec<String>>,
    /// Structural-relation edges per file, parallel to `files`. Parsed once here
    /// (lossy, D29) so the relations rules reuse one scan.
    pub relations: Vec<Vec<super::relations::RelationEdge>>,
    /// Local-node slug set per file, parallel to `files`. The Glossary terms +
    /// Workflow steps (STEP 3a) that a bare local relation endpoint resolves
    /// against; parsed once here.
    pub local_nodes: Vec<super::nodes::LocalNodes>,
}

impl<'a> LintContext<'a> {
    pub fn build(
        vault_root: &'a std::path::Path,
        files: &'a [crate::vault::VaultFile],
        assets: &[crate::vault::VaultAsset],
    ) -> Self {
        let mut cards = Vec::new();
        let mut references = Vec::new();

        for file in files {
            let type_val = crate::frontmatter::get_display(&file.frontmatter, "type");
            match type_val.as_str() {
                "card" => cards.push(file),
                "reference" => references.push(file),
                _ => {}
            }
        }

        let body_links: Vec<Vec<crate::wikilink::Wikilink>> = files
            .iter()
            .map(|f| crate::wikilink::extract(&f.content))
            .collect();
        let backlink_index = crate::wikilink::build_backlink_index_with(files, &body_links);

        // One mdstruct parse per file, shared by both structural scanners: the
        // relations edge scan and the local-node scan each need the same fenced-line
        // set and heading→slug map, so computing the facet once here avoids two
        // identical whole-document parses per file across the vault.
        let mut relations: Vec<Vec<super::relations::RelationEdge>> = Vec::with_capacity(files.len());
        let mut local_nodes: Vec<super::nodes::LocalNodes> = Vec::with_capacity(files.len());
        for f in files {
            let facet = crate::mdfacet::facet(&f.content);
            relations.push(super::relations::parse_relations_with_facet(
                &facet, &f.content,
            ));
            local_nodes.push(super::nodes::parse_local_nodes_with_facet(
                &facet, &f.content,
            ));
        }

        LintContext {
            vault_root,
            files,
            assets: assets.to_vec(),
            cards,
            references,
            body_links,
            backlink_index,
            relations,
            local_nodes,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_yaml::Value;
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    fn make_file(name: &str, type_val: Option<&str>) -> crate::vault::VaultFile {
        let mut fm = BTreeMap::new();
        if let Some(t) = type_val {
            fm.insert("type".to_string(), Value::String(t.to_string()));
        }
        crate::vault::VaultFile {
            name: name.to_string(),
            frontmatter: fm,
            ..Default::default()
        }
    }

    #[test]
    fn severity_deserialize_lowercase() {
        let off: Severity = serde_json::from_str("\"off\"").unwrap();
        assert_eq!(off, Severity::Off);

        let warn: Severity = serde_json::from_str("\"warn\"").unwrap();
        assert_eq!(warn, Severity::Warn);

        let error: Severity = serde_json::from_str("\"error\"").unwrap();
        assert_eq!(error, Severity::Error);
    }

    #[test]
    fn severity_deserialize_unknown_errors() {
        let result: Result<Severity, _> = serde_json::from_str("\"info\"");
        assert!(result.is_err());
    }

    #[test]
    fn lint_context_buckets_by_type() {
        let files = vec![
            make_file("card-one", Some("card")),
            make_file("ref-one", Some("reference")),
            make_file("no-type", None),
        ];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        assert_eq!(ctx.cards.len(), 1);
        assert_eq!(ctx.cards[0].name, "card-one");

        assert_eq!(ctx.references.len(), 1);
        assert_eq!(ctx.references[0].name, "ref-one");

        // no-type file must not appear in any bucket
        let all_bucketed: Vec<&str> = ctx
            .cards
            .iter()
            .chain(ctx.references.iter())
            .map(|f| f.name.as_str())
            .collect();
        assert!(!all_bucketed.contains(&"no-type"));
    }

    #[test]
    fn noop_rule_returns_empty() {
        struct Noop;
        impl Rule for Noop {
            fn name(&self) -> &'static str {
                "noop"
            }
            fn default_severity(&self) -> Severity {
                Severity::Warn
            }
            fn check(&self, _ctx: &LintContext) -> Vec<Finding> {
                vec![]
            }
        }

        let files: Vec<crate::vault::VaultFile> = vec![];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);
        assert!(Noop.check(&ctx).is_empty());
    }
}
