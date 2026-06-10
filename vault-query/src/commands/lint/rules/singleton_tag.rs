use std::collections::HashMap;

use crate::commands::lint::rule::{Finding, LintContext, Rule, Severity};
use crate::frontmatter;

pub struct SingletonTag;

impl Rule for SingletonTag {
    fn name(&self) -> &'static str {
        "singleton-tag"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warn
    }

    fn check(&self, ctx: &LintContext) -> Vec<Finding> {
        let mut tag_to_files: HashMap<String, Vec<&crate::vault::VaultFile>> = HashMap::new();
        for file in ctx.files {
            for tag in frontmatter::get_string_seq(&file.frontmatter, "tags") {
                tag_to_files.entry(tag).or_default().push(file);
            }
        }

        let mut findings = Vec::new();
        for (tag, files) in &tag_to_files {
            if files.len() == 1 {
                let file = files[0];
                findings.push(Finding {
                    rule: self.name(),
                    severity: self.default_severity(),
                    file: file.path.clone(),
                    message: format!("tag '{}' appears only in '{}'", tag, file.name),
                    data: Some(serde_json::json!({ "tag": tag })),
                });
            }
        }

        // Stable order for tests: sort by tag name.
        findings.sort_by(|a, b| {
            let ta = a
                .data
                .as_ref()
                .and_then(|v| v.get("tag"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let tb = b
                .data
                .as_ref()
                .and_then(|v| v.get("tag"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            ta.cmp(tb)
        });
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

    fn file_with_tags(name: &str, path: &str, tags: &[&str]) -> crate::vault::VaultFile {
        let mut fm = BTreeMap::new();
        fm.insert(
            "tags".to_string(),
            Value::Sequence(
                tags.iter()
                    .map(|t| Value::String(t.to_string()))
                    .collect(),
            ),
        );
        crate::vault::VaultFile {
            name: name.to_string(),
            path: PathBuf::from(path),
            frontmatter: fm,
            ..Default::default()
        }
    }

    fn file_with_type_and_tags(
        name: &str,
        path: &str,
        type_val: &str,
        tags: &[&str],
    ) -> crate::vault::VaultFile {
        let mut fm = BTreeMap::new();
        fm.insert("type".to_string(), Value::String(type_val.to_string()));
        fm.insert(
            "tags".to_string(),
            Value::Sequence(
                tags.iter()
                    .map(|t| Value::String(t.to_string()))
                    .collect(),
            ),
        );
        crate::vault::VaultFile {
            name: name.to_string(),
            path: PathBuf::from(path),
            frontmatter: fm,
            ..Default::default()
        }
    }

    fn file_no_tags(name: &str, path: &str) -> crate::vault::VaultFile {
        crate::vault::VaultFile {
            name: name.to_string(),
            path: PathBuf::from(path),
            ..Default::default()
        }
    }

    #[test]
    fn singleton_tag_appearing_once_emits_finding() {
        let foo = file_with_tags("Foo", "/vault/Foo.md", &["unique"]);
        let files = vec![foo];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = SingletonTag.check(&ctx);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, "singleton-tag");
        assert_eq!(findings[0].file, PathBuf::from("/vault/Foo.md"));
        assert!(findings[0].message.contains("unique"));
        assert!(findings[0].message.contains("Foo"));
    }

    #[test]
    fn tag_appearing_twice_emits_nothing() {
        let foo = file_with_tags("Foo", "/vault/Foo.md", &["common"]);
        let bar = file_with_tags("Bar", "/vault/Bar.md", &["common"]);
        let files = vec![foo, bar];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = SingletonTag.check(&ctx);
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn multiple_singleton_tags_one_file() {
        let foo = file_with_tags("Foo", "/vault/Foo.md", &["a", "b", "c"]);
        let files = vec![foo];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = SingletonTag.check(&ctx);
        assert_eq!(findings.len(), 3);
        // All findings point at Foo.
        for f in &findings {
            assert_eq!(f.file, PathBuf::from("/vault/Foo.md"));
        }
        // Sorted by tag name: a, b, c.
        let tags: Vec<&str> = findings
            .iter()
            .map(|f| {
                f.data
                    .as_ref()
                    .and_then(|v| v.get("tag"))
                    .and_then(|v| v.as_str())
                    .unwrap()
            })
            .collect();
        assert_eq!(tags, vec!["a", "b", "c"]);
    }

    #[test]
    fn mixed_singleton_and_shared() {
        let foo = file_with_tags("Foo", "/vault/Foo.md", &["unique", "common"]);
        let bar = file_with_tags("Bar", "/vault/Bar.md", &["common"]);
        let files = vec![foo, bar];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = SingletonTag.check(&ctx);
        assert_eq!(findings.len(), 1);
        assert!(findings[0].message.contains("unique"));
        assert!(findings[0].message.contains("Foo"));
    }

    #[test]
    fn default_severity_is_warn() {
        assert_eq!(SingletonTag.default_severity(), Severity::Warn);
    }

    #[test]
    fn singleton_tag_works_for_non_card_files() {
        let reference = file_with_type_and_tags(
            "SomeRef",
            "/vault/10 references/SomeRef.md",
            "reference",
            &["unique"],
        );
        let files = vec![reference];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = SingletonTag.check(&ctx);
        assert_eq!(findings.len(), 1);
        assert_eq!(
            findings[0].file,
            PathBuf::from("/vault/10 references/SomeRef.md")
        );
        assert!(findings[0].message.contains("unique"));
        assert!(findings[0].message.contains("SomeRef"));
    }

    #[test]
    fn file_without_tags_emits_nothing() {
        let foo = file_no_tags("Foo", "/vault/Foo.md");
        let files = vec![foo];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = SingletonTag.check(&ctx);
        assert_eq!(findings.len(), 0);
    }
}
