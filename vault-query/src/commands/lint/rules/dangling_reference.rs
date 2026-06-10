use std::collections::HashSet;

use crate::commands::lint::rule::{Finding, LintContext, Rule, Severity};
use crate::wikilink;
use crate::wikilink::normalize;

pub struct DanglingReference;

impl Rule for DanglingReference {
    fn name(&self) -> &'static str {
        "dangling-reference"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warn
    }

    fn check(&self, ctx: &LintContext) -> Vec<Finding> {
        let mut cited: HashSet<String> = HashSet::new();
        for card in &ctx.cards {
            if let Some(value) = card.frontmatter.get("reference") {
                wikilink::walk_frontmatter_links(value, &mut |link| {
                    cited.insert(normalize(wikilink::resolve_name(&link.target)));
                });
            }
        }

        let mut findings = Vec::new();
        for reference in &ctx.references {
            if !cited.contains(&normalize(&reference.name)) {
                findings.push(Finding {
                    rule: self.name(),
                    severity: self.default_severity(),
                    file: reference.path.clone(),
                    message: format!(
                        "reference '{}' is not cited by any card",
                        reference.name
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

    fn card_file(name: &str, reference_field: Option<Value>) -> crate::vault::VaultFile {
        let mut fm = BTreeMap::new();
        fm.insert("type".to_string(), Value::String("card".to_string()));
        if let Some(v) = reference_field {
            fm.insert("reference".to_string(), v);
        }
        crate::vault::VaultFile {
            name: name.to_string(),
            path: PathBuf::from(format!("/vault/20 cards/{}.md", name)),
            frontmatter: fm,
            ..Default::default()
        }
    }

    fn reference_file(name: &str) -> crate::vault::VaultFile {
        let mut fm = BTreeMap::new();
        fm.insert("type".to_string(), Value::String("reference".to_string()));
        crate::vault::VaultFile {
            name: name.to_string(),
            path: PathBuf::from(format!("/vault/10 references/{}.md", name)),
            frontmatter: fm,
            ..Default::default()
        }
    }

    #[test]
    fn dangling_reference_scalar_wikilink_not_cited() {
        // Card has a reference field with no wikilink; the reference is dangling.
        let ref_foo = reference_file("Foo");
        let card = card_file("Card", Some(Value::String("".to_string())));
        let files = vec![ref_foo, card];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = DanglingReference.check(&ctx);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, "dangling-reference");
        assert_eq!(
            findings[0].file,
            PathBuf::from("/vault/10 references/Foo.md")
        );
    }

    #[test]
    fn dangling_reference_scalar_wikilink_cited() {
        // Card cites reference via wikilink with folder prefix.
        let ref_foo = reference_file("Foo");
        let card = card_file(
            "Card",
            Some(Value::String("[[10 references/Foo]]".to_string())),
        );
        let files = vec![ref_foo, card];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = DanglingReference.check(&ctx);
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn dangling_reference_yaml_list_partial_citation() {
        // Two references; only Foo is cited, Bar is not.
        let ref_foo = reference_file("Foo");
        let ref_bar = reference_file("Bar");
        let card = card_file(
            "Card",
            Some(Value::Sequence(vec![Value::String("[[Foo]]".to_string())])),
        );
        let files = vec![ref_foo, ref_bar, card];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = DanglingReference.check(&ctx);
        assert_eq!(findings.len(), 1);
        assert_eq!(
            findings[0].file,
            PathBuf::from("/vault/10 references/Bar.md")
        );
    }

    #[test]
    fn dangling_reference_bare_form_no_folder_prefix() {
        // Wikilink without folder prefix; resolve_name strips path and lowercases.
        let ref_foo = reference_file("Foo");
        let card = card_file("Card", Some(Value::String("[[Foo]]".to_string())));
        let files = vec![ref_foo, card];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = DanglingReference.check(&ctx);
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn dangling_reference_nested_list() {
        // Nested sequence; recursive walk must reach the inner string.
        let ref_foo = reference_file("Foo");
        let card = card_file(
            "Card",
            Some(Value::Sequence(vec![Value::Sequence(vec![
                Value::String("[[Foo]]".to_string()),
            ])])),
        );
        let files = vec![ref_foo, card];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = DanglingReference.check(&ctx);
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn dangling_reference_curly_apostrophe_matches_straight() {
        // Card cites the reference with a curly apostrophe (U+2019) where the
        // on-disk filename uses a straight ASCII apostrophe (U+0027).
        // normalize() folds the typographic variant so the citation lands.
        let ref_foo = reference_file("Karpathy's gist");
        let card = card_file(
            "Card",
            Some(Value::String("[[Karpathy\u{2019}s gist]]".to_string())),
        );
        let files = vec![ref_foo, card];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = DanglingReference.check(&ctx);
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn dangling_reference_nbsp_matches_space() {
        // Card cites the reference with a no-break space (U+00A0) where the
        // on-disk filename uses a regular space (U+0020).  NFKC folds NBSP
        // into a plain space, so the citation lands.
        let ref_foo = reference_file("Two words");
        let card = card_file(
            "Card",
            Some(Value::String("[[Two\u{00A0}words]]".to_string())),
        );
        let files = vec![ref_foo, card];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = DanglingReference.check(&ctx);
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn dangling_reference_card_without_reference_field() {
        // Card has no reference field at all; the reference is dangling.
        let ref_foo = reference_file("Foo");
        let card = card_file("Card", None);
        let files = vec![ref_foo, card];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = DanglingReference.check(&ctx);
        assert_eq!(findings.len(), 1);
        assert_eq!(
            findings[0].message,
            "reference 'Foo' is not cited by any card"
        );
    }
}
