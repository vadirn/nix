use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Off,
    Warn,
    Error,
}


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
    pub backlink_index: HashMap<String, Vec<String>>,
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

        let backlink_index = crate::wikilink::build_backlink_index(files);

        LintContext {
            vault_root,
            files,
            assets: assets.to_vec(),
            cards,
            references,
            backlink_index,
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
