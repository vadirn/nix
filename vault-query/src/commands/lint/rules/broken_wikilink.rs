use std::collections::HashSet;
use std::path::Path;

use crate::commands::lint::rule::{Finding, LintContext, Rule, Severity};
use crate::vault;
use crate::wikilink;
use crate::wikilink::normalize;

/// Flags a `[[target]]` — in the body or in the YAML frontmatter — that names
/// no vault file and no asset.
///
/// Frontmatter coverage arrives through `ctx.frontmatter_links`, whose targets
/// come from YAML string scalars only (`key: "[[X]]"`, the form Obsidian
/// writes). A sequence value therefore never becomes a link target, so a
/// genuine nested array `key: [[a, b]]` cannot be misread as a link to
/// `a, b`. The opposite defect — an unquoted `key: [[X]]` that YAML turns into
/// a nested sequence — is a quoting fault rather than a resolution fault, and
/// belongs to `unquoted-frontmatter-link`.
///
/// Resolution is one code path for both surfaces, so a frontmatter target gets
/// the same `resolve_name`/`normalize` folding and the same asset handling a
/// body target gets, and the per-file dedup spans both: one missing target is
/// one defect and one fix, however many places in the file name it.
pub struct BrokenWikilink;

impl Rule for BrokenWikilink {
    fn name(&self) -> &'static str {
        "broken-wikilink"
    }

    fn default_severity(&self) -> Severity {
        Severity::Error
    }

    fn check(&self, ctx: &LintContext) -> Vec<Finding> {
        let known: HashSet<String> = ctx.files.iter().map(|f| normalize(&f.name)).collect();

        // Build a normalized basename index for asset bare-name lookups.
        let asset_basenames: HashSet<String> =
            ctx.assets.iter().map(|a| normalize(&a.name)).collect();

        let resolves = |target: &str| -> bool {
            // Detect whether the target carries a non-md asset extension.
            let ext = Path::new(target)
                .extension()
                .and_then(|e| e.to_str())
                .map(|s| s.to_lowercase());

            let is_asset = ext
                .as_deref()
                .map(|e| vault::ASSET_EXTENSIONS.contains(&e))
                .unwrap_or(false);

            if is_asset {
                if target.contains('/') {
                    // Path-qualified: compare vault-relative paths exactly.
                    let target_path = Path::new(target);
                    ctx.assets.iter().any(|a| {
                        a.path
                            .strip_prefix(ctx.vault_root)
                            .map(|rel| rel == target_path)
                            .unwrap_or(false)
                    })
                } else {
                    // Bare name: look up normalized basename.
                    asset_basenames.contains(&normalize(target))
                }
            } else {
                known.contains(&normalize(wikilink::resolve_name(target)))
            }
        };

        let mut findings = Vec::new();
        for (idx, file) in ctx.files.iter().enumerate() {
            let mut seen: HashSet<String> = HashSet::new();
            // Frontmatter first: it precedes the body in the file, so findings
            // come out in line order, and a target broken in both places keeps
            // the message naming the earlier occurrence.
            let surfaces = [
                (
                    ctx.frontmatter_links[idx].resolved.as_slice(),
                    "frontmatter wikilink",
                ),
                (ctx.body_links[idx].as_slice(), "wikilink"),
            ];
            for (links, surface) in surfaces {
                for link in links {
                    if resolves(&link.target) {
                        continue;
                    }
                    if !seen.insert(link.target.clone()) {
                        continue;
                    }
                    findings.push(Finding {
                        rule: self.name(),
                        severity: self.default_severity(),
                        file: file.path.clone(),
                        message: format!("{surface} target '{}' does not resolve", link.target),
                        data: Some(serde_json::json!({ "target": link.target, "line": link.line })),
                    });
                }
            }
        }
        findings
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::lint::rule::LintContext;
    use crate::vault::VaultAsset;
    use std::path::PathBuf;

    fn plain_file(name: &str, path: &str, content: &str) -> crate::vault::VaultFile {
        crate::vault::VaultFile {
            name: name.to_string(),
            path: PathBuf::from(path),
            content: content.to_string(),
            ..Default::default()
        }
    }

    /// A file whose frontmatter is parsed for real from `frontmatter_lines`,
    /// so the test exercises the same YAML representation `LintContext::build`
    /// sees in production — including YAML's own reading of an unquoted `[[`.
    fn fm_file(
        name: &str,
        path: &str,
        frontmatter_lines: &str,
        body: &str,
    ) -> crate::vault::VaultFile {
        let content = format!("---\n{frontmatter_lines}---\n{body}");
        let fm = crate::frontmatter::parse(&content).unwrap().unwrap();
        crate::vault::VaultFile {
            name: name.to_string(),
            path: PathBuf::from(path),
            frontmatter: fm,
            content,
            ..Default::default()
        }
    }

    fn make_asset(vault_root: &str, rel_path: &str) -> VaultAsset {
        let abs = PathBuf::from(vault_root).join(rel_path);
        let name = abs.file_name().unwrap().to_string_lossy().to_string();
        VaultAsset { path: abs, name }
    }

    #[test]
    fn broken_wikilink_resolves_to_existing_file_emits_nothing() {
        let foo = plain_file("Foo", "/vault/Foo.md", "");
        let bar = plain_file("Bar", "/vault/Bar.md", "");
        let src = plain_file("Src", "/vault/Src.md", "See [[Foo]].");
        let files = vec![foo, bar, src];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = BrokenWikilink.check(&ctx);
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn broken_wikilink_unresolved_target_emits_finding() {
        let foo = plain_file("Foo", "/vault/Foo.md", "");
        let bar = plain_file("Bar", "/vault/Bar.md", "");
        let src = plain_file("Src", "/vault/Src.md", "[[Quux]]");
        let files = vec![foo, bar, src];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = BrokenWikilink.check(&ctx);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, "broken-wikilink");
        assert!(findings[0].message.contains("'Quux'"));
        let data = findings[0].data.as_ref().unwrap();
        assert_eq!(data["target"], "Quux");
        assert_eq!(data["line"], 1);
    }

    #[test]
    fn broken_wikilink_dedups_within_one_source_file() {
        let src = plain_file("Src", "/vault/Src.md", "[[Quux]] and [[Quux]] again");
        let files = vec![src];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = BrokenWikilink.check(&ctx);
        assert_eq!(findings.len(), 1);
    }

    #[test]
    fn broken_wikilink_does_not_dedup_across_source_files() {
        let src_a = plain_file("SrcA", "/vault/SrcA.md", "[[Quux]]");
        let src_b = plain_file("SrcB", "/vault/SrcB.md", "[[Quux]]");
        let files = vec![src_a, src_b];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = BrokenWikilink.check(&ctx);
        assert_eq!(findings.len(), 2);
    }

    #[test]
    fn broken_wikilink_path_prefix_in_target_resolves_via_resolve_name() {
        let bar = plain_file("Bar", "/vault/Bar.md", "");
        let src = plain_file("Src", "/vault/Src.md", "[[path/to/Bar]]");
        let files = vec![bar, src];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        // resolve_name("path/to/Bar") == "Bar", so this must resolve cleanly.
        let findings = BrokenWikilink.check(&ctx);
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn broken_wikilink_path_prefix_target_data_is_raw_when_broken() {
        let bar = plain_file("Bar", "/vault/Bar.md", "");
        let src = plain_file("Src", "/vault/Src.md", "[[path/to/Quux]]");
        let files = vec![bar, src];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = BrokenWikilink.check(&ctx);
        assert_eq!(findings.len(), 1);
        let data = findings[0].data.as_ref().unwrap();
        // data.target must be the raw input, not the resolved stem.
        assert_eq!(data["target"], "path/to/Quux");
        assert_eq!(data["line"], 1);
    }

    #[test]
    fn broken_wikilink_alias_form_resolves() {
        let foo = plain_file("Foo", "/vault/Foo.md", "");
        let src = plain_file("Src", "/vault/Src.md", "[[Foo|Display]]");
        let files = vec![foo, src];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = BrokenWikilink.check(&ctx);
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn broken_wikilink_finding_carries_line_number_for_multiline_body() {
        let src = plain_file("Src", "/vault/Src.md", "line 1\nline 2\n[[Quux]]\n");
        let files = vec![src];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = BrokenWikilink.check(&ctx);
        assert_eq!(findings.len(), 1);
        let data = findings[0].data.as_ref().unwrap();
        assert_eq!(data["target"], "Quux");
        assert_eq!(data["line"], 3);
    }

    #[test]
    fn broken_wikilink_default_severity_is_error() {
        assert_eq!(BrokenWikilink.default_severity(), Severity::Error);
    }

    // --- Asset resolution tests ---

    #[test]
    fn broken_wikilink_asset_bare_name_resolves() {
        let src = plain_file("Src", "/vault/Src.md", "See [[Foo.png]].");
        let files = vec![src];
        let root = PathBuf::from("/vault");
        let assets = vec![make_asset("/vault", "assets/Foo.png")];
        let ctx = LintContext::build(&root, &files, &assets);

        let findings = BrokenWikilink.check(&ctx);
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn broken_wikilink_asset_path_qualified_resolves() {
        let src = plain_file(
            "Src",
            "/vault/Src.md",
            "See [[41 projects/nix/Checkpoints.base]].",
        );
        let files = vec![src];
        let root = PathBuf::from("/vault");
        let assets = vec![make_asset("/vault", "41 projects/nix/Checkpoints.base")];
        let ctx = LintContext::build(&root, &files, &assets);

        let findings = BrokenWikilink.check(&ctx);
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn broken_wikilink_asset_missing_stays_broken() {
        let src = plain_file("Src", "/vault/Src.md", "[[Nonexistent.png]]");
        let files = vec![src];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = BrokenWikilink.check(&ctx);
        assert_eq!(findings.len(), 1);
        let data = findings[0].data.as_ref().unwrap();
        assert_eq!(data["target"], "Nonexistent.png");
    }

    #[test]
    fn broken_wikilink_asset_ignored_stays_broken() {
        // Simulate ignore filtering by simply not including Secret.pdf in the assets slice.
        let src = plain_file("Src", "/vault/Src.md", "[[Secret.pdf]]");
        let files = vec![src];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = BrokenWikilink.check(&ctx);
        assert_eq!(findings.len(), 1);
    }

    #[test]
    fn broken_wikilink_asset_basename_collision_resolves() {
        let src = plain_file("Src", "/vault/Src.md", "[[Diagram.png]]");
        let files = vec![src];
        let root = PathBuf::from("/vault");
        let assets = vec![
            make_asset("/vault", "folder-a/Diagram.png"),
            make_asset("/vault", "folder-b/Diagram.png"),
        ];
        let ctx = LintContext::build(&root, &files, &assets);

        let findings = BrokenWikilink.check(&ctx);
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn broken_wikilink_asset_raw_target_preserved() {
        let src = plain_file("Src", "/vault/Src.md", "[[path/to/Nonexistent.base]]");
        let files = vec![src];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = BrokenWikilink.check(&ctx);
        assert_eq!(findings.len(), 1);
        let data = findings[0].data.as_ref().unwrap();
        assert_eq!(data["target"], "path/to/Nonexistent.base");
    }

    #[test]
    fn broken_wikilink_asset_line_unaffected() {
        let src = plain_file("Src", "/vault/Src.md", "line 1\nline 2\n[[Missing.png]]\n");
        let files = vec![src];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = BrokenWikilink.check(&ctx);
        assert_eq!(findings.len(), 1);
        let data = findings[0].data.as_ref().unwrap();
        assert_eq!(data["target"], "Missing.png");
        assert_eq!(data["line"], 3);
    }

    // --- Frontmatter link tests ---

    #[test]
    fn broken_wikilink_quoted_frontmatter_link_resolves() {
        let target = plain_file("Nix", "/vault/41 projects/nix/Nix.md", "");
        let src = fm_file(
            "Src",
            "/vault/Src.md",
            "type: ticket\nproject: \"[[41 projects/nix/Nix]]\"\n",
            "Body.",
        );
        let files = vec![target, src];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        assert_eq!(BrokenWikilink.check(&ctx).len(), 0);
    }

    #[test]
    fn broken_wikilink_quoted_frontmatter_link_that_does_not_resolve_emits_finding() {
        let src = fm_file(
            "Src",
            "/vault/Src.md",
            "type: ticket\nproject: \"[[41 projects/nix/Nowhere]]\"\n",
            "Body.",
        );
        let files = vec![src];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = BrokenWikilink.check(&ctx);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, "broken-wikilink");
        assert_eq!(findings[0].severity, Severity::Error);
        let data = findings[0].data.as_ref().unwrap();
        assert_eq!(data["target"], "41 projects/nix/Nowhere");
        assert!(
            findings[0].message.contains("frontmatter wikilink target"),
            "unexpected message: {}",
            findings[0].message
        );
    }

    #[test]
    fn broken_wikilink_unquoted_frontmatter_link_emits_nothing() {
        // `project: [[X]]` is a nested sequence to YAML, not a string, so no
        // link target exists to resolve. `unquoted-frontmatter-link` owns it.
        let src = fm_file(
            "Src",
            "/vault/Src.md",
            "type: ticket\nproject: [[Nowhere]]\n",
            "Body.",
        );
        let files = vec![src];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        assert_eq!(BrokenWikilink.check(&ctx).len(), 0);
    }

    #[test]
    fn broken_wikilink_nested_array_is_never_a_link_target() {
        // `[[a, b]]` is a real nested array. A raw-text scan would invent the
        // target `a, b`; resolving from string scalars only cannot.
        let src = fm_file(
            "Src",
            "/vault/Src.md",
            "type: note\nmatrix: [[a, b]]\n",
            "Body.",
        );
        let files = vec![src];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        assert_eq!(BrokenWikilink.check(&ctx).len(), 0);
    }

    #[test]
    fn broken_wikilink_frontmatter_sequence_is_checked_element_by_element() {
        // A sequence must be walked per element, not joined into one display
        // string: the good entry resolves, only the bad one is flagged.
        let good = plain_file("ticket-foo", "/vault/41 projects/p/ticket-foo.md", "");
        let src = fm_file(
            "Src",
            "/vault/Src.md",
            "type: ticket\nrequires:\n  - \"[[41 projects/p/ticket-foo]]\"\n  - \"[[41 projects/p/ticket-missing]]\"\n",
            "Body.",
        );
        let files = vec![good, src];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = BrokenWikilink.check(&ctx);
        assert_eq!(findings.len(), 1);
        assert_eq!(
            findings[0].data.as_ref().unwrap()["target"],
            "41 projects/p/ticket-missing"
        );
    }

    #[test]
    fn broken_wikilink_frontmatter_finding_carries_absolute_line() {
        // Frontmatter opens on line 1, so the raw-block line is already the
        // absolute file line: `---` is 1, `type:` is 2, `project:` is 3.
        let src = fm_file(
            "Src",
            "/vault/Src.md",
            "type: ticket\nstatus: open\nproject: \"[[Nowhere]]\"\n",
            "Body with [[AlsoNowhere]].",
        );
        let files = vec![src];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = BrokenWikilink.check(&ctx);
        assert_eq!(findings.len(), 2);
        let fm_finding = findings
            .iter()
            .find(|f| f.data.as_ref().unwrap()["target"] == "Nowhere")
            .expect("expected a finding for the frontmatter target");
        assert_eq!(fm_finding.data.as_ref().unwrap()["line"], 4);
        let body_finding = findings
            .iter()
            .find(|f| f.data.as_ref().unwrap()["target"] == "AlsoNowhere")
            .expect("expected a finding for the body target");
        assert_eq!(body_finding.data.as_ref().unwrap()["line"], 6);
    }

    #[test]
    fn broken_wikilink_dedups_one_target_across_frontmatter_and_body() {
        let src = fm_file(
            "Src",
            "/vault/Src.md",
            "type: ticket\nproject: \"[[Nowhere]]\"\n",
            "Body cites [[Nowhere]] too.",
        );
        let files = vec![src];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        assert_eq!(BrokenWikilink.check(&ctx).len(), 1);
    }

    // --- Unicode normalization tests ---

    #[test]
    fn broken_wikilink_curly_apostrophe_matches_straight() {
        // File on disk uses a straight ASCII apostrophe (U+0027) in its name;
        // the wikilink uses a curly apostrophe (U+2019).  normalize() folds the
        // typographic variant so the link resolves and produces zero findings.
        let target = plain_file("Karpathy's gist", "/vault/Karpathy's gist.md", "");
        let src = plain_file("Src", "/vault/Src.md", "[[Karpathy\u{2019}s gist]]");
        let files = vec![target, src];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = BrokenWikilink.check(&ctx);
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn broken_wikilink_nbsp_matches_space() {
        // File on disk uses a regular space (U+0020) in its name; the wikilink
        // uses a no-break space (U+00A0).  NFKC folds NBSP into a plain space
        // so the link resolves and produces zero findings.
        let target = plain_file("Two words", "/vault/Two words.md", "");
        let src = plain_file("Src", "/vault/Src.md", "[[Two\u{00A0}words]]");
        let files = vec![target, src];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = BrokenWikilink.check(&ctx);
        assert_eq!(findings.len(), 0);
    }
}
