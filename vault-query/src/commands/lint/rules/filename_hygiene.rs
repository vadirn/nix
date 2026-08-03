use crate::commands::lint::rule::{Finding, LintContext, Rule, Severity};

/// Flags a basename that carries a smart quote, a double space, or a space
/// immediately before the `.md` suffix.
///
/// These three are typing accidents, not naming choices: a curly quote
/// autocorrected in place of a straight one, a stray extra space from a
/// copy-paste, or a trailing space left before the extension when a title was
/// edited. None of them is ever intentional, so the rule needs no frontmatter
/// and no type check to decide whether a name is in breach — it reads the
/// basename alone and applies to every file in the vault.
///
/// This is why it does not fold into `slug-filename-mismatch` or
/// `singleton-filename-mismatch`: those two ask "is this the right name" by
/// comparing a basename against a value the file itself declares
/// (`slug:` or `type:`); this one asks "is this name well-formed" and reads
/// nothing but the name.
///
/// One finding per file: a name can carry more than one of the three issues
/// at once (a double space that also lands right before `.md`, say), and
/// reporting each separately would describe one bad filename as several
/// unrelated defects. `data.issues` lists every applicable kind so a future
/// fixer can dispatch per issue without re-deriving it from the raw basename.
pub struct FilenameHygiene;

/// The smart-quote codepoints this rule flags: the curly single-quote pair
/// U+2018/U+2019 and the curly double-quote pair U+201C/U+201D — the marks a
/// word processor's autocorrect substitutes for a straight `'` or `"`. The
/// low-9 quotes (U+201A, U+201E) and guillemets (U+00AB, U+00BB) are a
/// different mark family, used deliberately in some Russian filenames rather
/// than produced by accident, so they stay out of this set.
const SMART_QUOTES: [char; 4] = ['\u{2018}', '\u{2019}', '\u{201C}', '\u{201D}'];

impl Rule for FilenameHygiene {
    fn name(&self) -> &'static str {
        "filename-hygiene"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warn
    }

    fn check(&self, ctx: &LintContext) -> Vec<Finding> {
        let mut findings = Vec::new();

        for file in ctx.files {
            let mut issues: Vec<&'static str> = Vec::new();

            if file.name.chars().any(|c| SMART_QUOTES.contains(&c)) {
                issues.push("smart-quote");
            }
            if file.name.contains("  ") {
                issues.push("double-space");
            }
            // `file.name` is the basename's `file_stem`, so a space carried
            // over from immediately before the stripped `.md` suffix
            // surfaces as a trailing space here.
            if file.name.ends_with(' ') {
                issues.push("trailing-space");
            }

            if issues.is_empty() {
                continue;
            }

            findings.push(Finding {
                rule: self.name(),
                severity: self.default_severity(),
                file: file.path.clone(),
                message: format!(
                    "'{}.md' basename is not hygienic: {}",
                    file.name,
                    issues.join(", ")
                ),
                data: Some(serde_json::json!({ "issues": issues })),
            });
        }

        findings
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// A vault file named as given, with no frontmatter — this rule reads
    /// none.
    fn make_file(name: &str) -> crate::vault::VaultFile {
        crate::vault::VaultFile {
            name: name.to_string(),
            path: PathBuf::from(format!("/vault/41 projects/nix/{name}.md")),
            ..Default::default()
        }
    }

    fn check(files: Vec<crate::vault::VaultFile>) -> Vec<Finding> {
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);
        FilenameHygiene.check(&ctx)
    }

    #[test]
    fn a_clean_basename_is_silent() {
        let files = vec![make_file("track-vault-lint-hygiene")];
        assert!(check(files).is_empty());
    }

    /// A left or right curly single quote fires `smart-quote`.
    #[test]
    fn a_curly_single_quote_fires_smart_quote() {
        for name in ["Vadim\u{2018}s Notes", "Vadim\u{2019}s Notes"] {
            let findings = check(vec![make_file(name)]);
            assert_eq!(findings.len(), 1, "name: {name}");
            assert_eq!(findings[0].rule, "filename-hygiene");
            assert_eq!(findings[0].severity, Severity::Warn);
            assert_eq!(
                findings[0].data.as_ref().unwrap()["issues"],
                serde_json::json!(["smart-quote"])
            );
        }
    }

    /// A left or right curly double quote fires `smart-quote`.
    #[test]
    fn a_curly_double_quote_fires_smart_quote() {
        for name in ["\u{201C}Quoted\u{201D} Title", "\u{201C}Quoted Title"] {
            let findings = check(vec![make_file(name)]);
            assert_eq!(findings.len(), 1, "name: {name}");
            assert_eq!(
                findings[0].data.as_ref().unwrap()["issues"],
                serde_json::json!(["smart-quote"])
            );
        }
    }

    /// A guillemet is a different mark family, used deliberately, so it is
    /// silent.
    #[test]
    fn a_guillemet_is_silent() {
        let files = vec![make_file("\u{00AB}Quoted\u{00BB} Title")];
        assert!(check(files).is_empty());
    }

    /// Two consecutive spaces mid-name fire `double-space`.
    #[test]
    fn a_double_space_mid_name_fires_double_space() {
        let files = vec![make_file("track  vault  lint")];
        let findings = check(files);
        assert_eq!(findings.len(), 1);
        assert_eq!(
            findings[0].data.as_ref().unwrap()["issues"],
            serde_json::json!(["double-space"])
        );
    }

    /// A space immediately before the stripped `.md` suffix surfaces as a
    /// trailing space on `file.name` and fires `trailing-space`.
    #[test]
    fn a_trailing_space_before_md_fires_trailing_space() {
        let files = vec![make_file("track-vault-lint-hygiene ")];
        let findings = check(files);
        assert_eq!(findings.len(), 1);
        assert_eq!(
            findings[0].data.as_ref().unwrap()["issues"],
            serde_json::json!(["trailing-space"])
        );
    }

    /// A single space between words is not a double space and does not sit
    /// at the end of the name, so it is silent.
    #[test]
    fn a_single_interior_space_is_silent() {
        let files = vec![make_file("track vault lint")];
        assert!(check(files).is_empty());
    }

    /// All three issues co-occurring in one basename still produce exactly
    /// one finding, with every applicable issue listed rather than just the
    /// first detected.
    #[test]
    fn all_three_issues_together_produce_one_finding_listing_all() {
        let files = vec![make_file("Vadim\u{2019}s  Notes ")];
        let findings = check(files);
        assert_eq!(findings.len(), 1);
        assert_eq!(
            findings[0].data.as_ref().unwrap()["issues"],
            serde_json::json!(["smart-quote", "double-space", "trailing-space"])
        );
        assert!(
            findings[0].message.contains("smart-quote")
                && findings[0].message.contains("double-space")
                && findings[0].message.contains("trailing-space"),
            "unexpected message: {}",
            findings[0].message
        );
    }

    /// Two independent clean files produce no findings and do not leak state
    /// between iterations.
    #[test]
    fn multiple_clean_files_are_silent() {
        let files = vec![make_file("track-a"), make_file("track-b")];
        assert!(check(files).is_empty());
    }
}
