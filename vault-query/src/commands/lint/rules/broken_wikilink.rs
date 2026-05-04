use std::collections::HashSet;
use std::path::Path;

use crate::commands::lint::rule::{Category, Finding, LintContext, Rule, Severity};
use crate::vault;
use crate::wikilink;

pub struct BrokenWikilink;

impl Rule for BrokenWikilink {
    fn name(&self) -> &'static str {
        "broken-wikilink"
    }

    fn category(&self) -> Category {
        Category::Structural
    }

    fn default_severity(&self) -> Severity {
        Severity::Error
    }

    fn check(&self, ctx: &LintContext) -> Vec<Finding> {
        let known: HashSet<String> = ctx.files.iter().map(|f| f.name.to_lowercase()).collect();

        // Build a lowercase basename index for asset bare-name lookups.
        let asset_basenames: HashSet<String> =
            ctx.assets.iter().map(|a| a.name.to_lowercase()).collect();

        let mut findings = Vec::new();
        for file in ctx.files {
            let mut seen: HashSet<String> = HashSet::new();
            for link in wikilink::extract(&file.content) {
                // Detect whether the target carries a non-md asset extension.
                let ext = Path::new(&link.target)
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|s| s.to_lowercase());

                let is_asset = ext
                    .as_deref()
                    .map(|e| vault::ASSET_EXTENSIONS.contains(&e))
                    .unwrap_or(false);

                let resolves = if is_asset {
                    if link.target.contains('/') {
                        // Path-qualified: compare vault-relative paths exactly.
                        let target_path = Path::new(&link.target);
                        ctx.assets.iter().any(|a| {
                            a.path
                                .strip_prefix(ctx.vault_root)
                                .map(|rel| rel == target_path)
                                .unwrap_or(false)
                        })
                    } else {
                        // Bare name: look up lowercase basename.
                        asset_basenames.contains(&link.target.to_lowercase())
                    }
                } else {
                    let resolved = wikilink::resolve_name(&link.target).to_lowercase();
                    known.contains(&resolved)
                };

                if resolves {
                    continue;
                }
                if !seen.insert(link.target.clone()) {
                    continue;
                }
                findings.push(Finding {
                    rule: self.name(),
                    severity: self.default_severity(),
                    file: file.path.clone(),
                    message: format!("wikilink target '{}' does not resolve", link.target),
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

    fn make_asset(vault_root: &str, rel_path: &str) -> VaultAsset {
        let abs = PathBuf::from(vault_root).join(rel_path);
        let name = abs
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
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
        let src = plain_file(
            "Src",
            "/vault/Src.md",
            "line 1\nline 2\n[[Missing.png]]\n",
        );
        let files = vec![src];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let findings = BrokenWikilink.check(&ctx);
        assert_eq!(findings.len(), 1);
        let data = findings[0].data.as_ref().unwrap();
        assert_eq!(data["target"], "Missing.png");
        assert_eq!(data["line"], 3);
    }
}
