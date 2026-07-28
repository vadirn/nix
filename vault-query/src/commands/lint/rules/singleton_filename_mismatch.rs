use crate::commands::lint::rule::{Finding, LintContext, Rule, Severity};
use crate::frontmatter;

/// Flags a file whose `type:` says a project holds exactly one of it, but whose
/// filename is not the name that type reserves.
///
/// A project folder mixes two populations. The many-per-project files are named
/// `<type>-<slug>` in lowercase and `slug-filename-mismatch` keeps that half
/// honest. The one-per-project files are named for what they are, capitalized —
/// `Context.md`, `Scratchpad.md`, beside `Tracks.base` and the project note.
/// Casing is what separates the two at a glance in a listing that interleaves
/// them, so a lowercase `context.md` reads as a `<type>-<slug>` file with its
/// slug missing.
///
/// The name is also the only address these files have. They carry no `slug:`,
/// and `commands/context.rs` reaches one by joining a constant onto the project
/// path rather than by scanning for a `type:` — so a misnamed one is not found
/// at all, and the command prints nothing rather than reporting a problem.
///
/// A file carrying no `type:` is skipped: `untyped-entry` reports that, and this
/// rule cannot know a file is a singleton without being told.
///
/// Exempt: templates and superseded entries. `templates/Scratchpad.md` is the
/// source a project's scratchpad is instantiated from, not a project's own.
pub struct SingletonFilenameMismatch;

/// The types a project holds exactly one of, each with the basename it reserves.
const SINGLETON_TYPES: [(&str, &str); 2] = [("context", "Context"), ("scratchpad", "Scratchpad")];

impl Rule for SingletonFilenameMismatch {
    fn name(&self) -> &'static str {
        "singleton-filename-mismatch"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warn
    }

    fn check(&self, ctx: &LintContext) -> Vec<Finding> {
        let mut findings = Vec::new();

        for file in ctx.files {
            if crate::epistemic::is_lint_exempt(&file.frontmatter) {
                continue;
            }
            let type_val = frontmatter::get_display(&file.frontmatter, "type");
            let Some((_, expected)) = SINGLETON_TYPES
                .iter()
                .find(|(singleton, _)| *singleton == type_val)
            else {
                continue;
            };

            if file.name != *expected {
                findings.push(Finding {
                    rule: self.name(),
                    severity: self.default_severity(),
                    file: file.path.clone(),
                    message: format!(
                        "'{}' is its project's {}, of which a project holds one, \
                         so its file should be named '{}.md'",
                        file.name, type_val, expected
                    ),
                    data: Some(serde_json::json!({
                        "type": type_val,
                        "expected": expected,
                    })),
                });
            }
        }

        findings
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_yaml::Value;
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    /// A vault file under `41 projects/nix`, typed as given.
    fn make_file(name: &str, type_val: Option<&str>) -> crate::vault::VaultFile {
        let mut fm = BTreeMap::new();
        if let Some(t) = type_val {
            fm.insert("type".to_string(), Value::String(t.to_string()));
        }
        crate::vault::VaultFile {
            name: name.to_string(),
            path: PathBuf::from(format!("/vault/41 projects/nix/{name}.md")),
            frontmatter: fm,
            ..Default::default()
        }
    }

    fn check(files: Vec<crate::vault::VaultFile>) -> Vec<Finding> {
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);
        SingletonFilenameMismatch.check(&ctx)
    }

    #[test]
    fn the_reserved_names_are_silent() {
        let files = vec![
            make_file("Context", Some("context")),
            make_file("Scratchpad", Some("scratchpad")),
        ];
        assert!(check(files).is_empty());
    }

    /// The case this rule exists for: the spelling the scaffolding used before
    /// singleton files were named for what they are.
    #[test]
    fn a_lowercase_singleton_names_the_file_it_should_be() {
        let files = vec![make_file("context", Some("context"))];
        let findings = check(files);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, "singleton-filename-mismatch");
        assert_eq!(findings[0].severity, Severity::Warn);
        assert!(
            findings[0].message.contains("'Context.md'"),
            "unexpected message: {}",
            findings[0].message
        );
        let data = findings[0].data.as_ref().unwrap();
        assert_eq!(data["type"], "context");
        assert_eq!(data["expected"], "Context");
    }

    /// A singleton carries no slug, so `<type>-<slug>` is not an alternative
    /// spelling of its name — it is a second one-per-project file.
    #[test]
    fn a_slug_style_name_is_a_mismatch() {
        let files = vec![make_file("scratchpad-seeds", Some("scratchpad"))];
        assert_eq!(check(files).len(), 1);
    }

    #[test]
    fn a_type_a_project_holds_many_of_is_silent() {
        let files = vec![
            make_file("track-mdstruct", Some("track")),
            make_file("ticket-tickets-via-base", Some("ticket")),
            make_file("Some Card", Some("card")),
        ];
        assert!(check(files).is_empty());
    }

    /// One defect, one finding: a file with no `type:` is `untyped-entry`'s, and
    /// this rule cannot tell a singleton from anything else without it.
    #[test]
    fn an_untyped_file_is_left_to_untyped_entry() {
        let files = vec![make_file("context", None)];
        assert!(check(files).is_empty());
    }

    /// `templates/Scratchpad.md` already conforms, but a template is exempt on
    /// principle: it is what a project's singleton is instantiated from.
    #[test]
    fn a_template_is_silent() {
        let mut file = make_file("Project Context", Some("context"));
        file.frontmatter
            .insert("template".to_string(), Value::Bool(true));
        assert!(check(vec![file]).is_empty());
    }

    #[test]
    fn a_superseded_entry_is_silent() {
        let mut file = make_file("context", Some("context"));
        file.frontmatter
            .insert("superseded".to_string(), Value::Bool(true));
        assert!(check(vec![file]).is_empty());
    }
}
