use crate::commands::lint::rule::{Finding, LintContext, Rule, Severity};
use crate::frontmatter;

/// Flags a ticket or track whose filename disagrees with `<type>-<slug>`.
///
/// The two are one identity written twice, and queries read the filename half.
/// `commands/tickets.rs` derives `--track`'s slug from the *stem* of the
/// wikilink a ticket backrefs, deliberately, so resolution never depends on the
/// linked file being present or scannable — and `--track` validates its argument
/// against the stems of the project's track files. So when a track's stem and
/// its `slug:` disagree, the track is addressable only by the name that is not
/// written inside it, and `--track <the slug it declares>` reports it as unknown.
///
/// Only `ticket` and `track` are named `<type>-<slug>`. A `checkpoint` is
/// timestamped and declares no slug; cards, notes, and references are named by
/// their title.
///
/// Skips an entry whose `slug:` is absent: `slug` is already required for both
/// types, so `missing-required-field` reports that, and firing here as well
/// would name one defect twice.
///
/// Exempt: templates and superseded entries. A template legitimately has no
/// slug — the field is filled in at instantiation — so `templates/Ticket.md` is
/// correct as it stands rather than in breach.
pub struct SlugFilenameMismatch;

/// The types whose filename encodes their slug.
const SLUG_NAMED_TYPES: [&str; 2] = ["ticket", "track"];

impl Rule for SlugFilenameMismatch {
    fn name(&self) -> &'static str {
        "slug-filename-mismatch"
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
            if !SLUG_NAMED_TYPES.contains(&type_val.as_str()) {
                continue;
            }
            let slug = frontmatter::get_display(&file.frontmatter, "slug");
            if slug.is_empty() {
                continue;
            }

            let expected = format!("{type_val}-{slug}");
            if file.name != expected {
                findings.push(Finding {
                    rule: self.name(),
                    severity: self.default_severity(),
                    file: file.path.clone(),
                    message: format!(
                        "'{}' declares slug '{}', so its file should be named '{}.md'; \
                         queries resolve it by filename",
                        file.name, slug, expected
                    ),
                    data: Some(serde_json::json!({
                        "slug": slug,
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

    /// A vault file under `41 projects/nix`, typed and slugged as given.
    fn make_file(name: &str, type_val: &str, slug: Option<&str>) -> crate::vault::VaultFile {
        let mut fm = BTreeMap::new();
        fm.insert("type".to_string(), Value::String(type_val.to_string()));
        if let Some(s) = slug {
            fm.insert("slug".to_string(), Value::String(s.to_string()));
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
        SlugFilenameMismatch.check(&ctx)
    }

    #[test]
    fn a_matching_name_is_silent() {
        let files = vec![
            make_file("track-distill-interact", "track", Some("distill-interact")),
            make_file(
                "ticket-tickets-via-base",
                "ticket",
                Some("tickets-via-base"),
            ),
        ];
        assert!(check(files).is_empty());
    }

    #[test]
    fn a_disagreeing_name_names_the_file_it_should_be() {
        let files = vec![make_file(
            "track-distill",
            "track",
            Some("distill-interact"),
        )];
        let findings = check(files);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, "slug-filename-mismatch");
        assert_eq!(findings[0].severity, Severity::Warn);
        assert!(
            findings[0].message.contains("'track-distill-interact.md'"),
            "unexpected message: {}",
            findings[0].message
        );
        let data = findings[0].data.as_ref().unwrap();
        assert_eq!(data["expected"], "track-distill-interact");
        assert_eq!(data["slug"], "distill-interact");
    }

    /// The prefix is part of the name, so a bare slug is a mismatch: dropping it
    /// is what makes a track unreachable through a ticket's backref stem.
    #[test]
    fn a_missing_type_prefix_is_a_mismatch() {
        let files = vec![make_file(
            "distill-interact",
            "track",
            Some("distill-interact"),
        )];
        assert_eq!(check(files).len(), 1);
    }

    /// One defect, one finding: `slug` is required for both types, so an absent
    /// one is `missing-required-field`'s to report.
    #[test]
    fn an_absent_slug_is_left_to_missing_required_field() {
        let files = vec![make_file("track-distill-interact", "track", None)];
        assert!(check(files).is_empty());
    }

    #[test]
    fn a_type_not_named_by_its_slug_is_silent() {
        let files = vec![
            make_file("checkpoint-2026-03-02-19-10-46", "checkpoint", None),
            make_file("Some Card", "card", None),
        ];
        assert!(check(files).is_empty());
    }

    /// `templates/Ticket.md` carries `type: ticket` and no slug of its own; the
    /// field is filled in at instantiation.
    #[test]
    fn a_template_is_silent() {
        let mut file = make_file("Ticket", "ticket", Some("the-slug"));
        file.frontmatter
            .insert("template".to_string(), Value::Bool(true));
        assert!(check(vec![file]).is_empty());
    }

    #[test]
    fn a_superseded_entry_is_silent() {
        let mut file = make_file("track-old", "track", Some("renamed"));
        file.frontmatter
            .insert("superseded".to_string(), Value::Bool(true));
        assert!(check(vec![file]).is_empty());
    }
}
