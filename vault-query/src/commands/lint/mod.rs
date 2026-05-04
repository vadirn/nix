pub mod config;
pub mod format;
pub mod registry;
pub mod rule;
pub mod rules;

use anyhow::Result;
use std::io::Write;

use self::config::effective_severities;
use self::format::LintFormat;
use self::registry::built_in_rules;
use self::rule::{Finding, LintContext, Severity};

/// Public entry: run lint, write to stdout, return process exit code.
pub fn run(
    cfg: &crate::config::ResolvedConfig,
    format: LintFormat,
    cli_rules: &[String],
) -> Result<i32> {
    let stdout = std::io::stdout();
    let mut handle = stdout.lock();
    run_with_writer(cfg, format, cli_rules, &mut handle)
}

/// Testable dispatcher: same logic as `run` but writes to an arbitrary writer.
pub fn run_with_writer<W: Write>(
    cfg: &crate::config::ResolvedConfig,
    format: LintFormat,
    cli_rules: &[String],
    out: &mut W,
) -> Result<i32> {
    let files = crate::vault::scan(&cfg.vault_root, &cfg.vault_root, cfg.ignore.as_ref())?;
    let ctx = LintContext::build(&cfg.vault_root, &files);

    let overrides = effective_severities(cfg.lint.as_ref(), cli_rules)?;

    let mut findings: Vec<Finding> = Vec::new();
    for rule in built_in_rules() {
        let sev = overrides
            .get(rule.name())
            .copied()
            .unwrap_or_else(|| rule.default_severity());
        if sev == Severity::Off {
            continue;
        }
        let mut rule_findings = rule.check(&ctx);
        for f in &mut rule_findings {
            f.severity = sev;
            if let Ok(rel) = f.file.strip_prefix(&cfg.vault_root) {
                f.file = rel.to_path_buf();
            }
        }
        findings.extend(rule_findings);
    }

    findings.sort_by(|a, b| {
        a.file
            .as_path()
            .cmp(b.file.as_path())
            .then_with(|| a.rule.cmp(b.rule))
    });

    match format {
        LintFormat::Text => render_text(&findings, out)?,
        LintFormat::Json => render_json(&findings, out)?,
        LintFormat::Summary => render_summary(&findings, out)?,
    }

    let any_error = findings.iter().any(|f| f.severity == Severity::Error);
    Ok(if any_error { 1 } else { 0 })
}

fn render_text<W: Write>(findings: &[Finding], out: &mut W) -> Result<()> {
    for f in findings {
        let sev = match f.severity {
            Severity::Off => "off",
            Severity::Warn => "warn",
            Severity::Error => "error",
        };
        writeln!(
            out,
            "[{}] {}  {}: {}",
            sev,
            f.rule,
            f.file.display(),
            f.message
        )?;
    }
    Ok(())
}

fn render_json<W: Write>(findings: &[Finding], out: &mut W) -> Result<()> {
    let array: serde_json::Value = findings
        .iter()
        .map(|f| {
            // Convert PathBuf to a string with forward slashes (safe on macOS already,
            // explicit replace guards against Windows CI if this ever runs there).
            let file_str = f.file.to_string_lossy().replace('\\', "/");
            serde_json::json!({
                "rule": f.rule,
                "severity": f.severity,
                "file": file_str,
                "message": f.message,
                "data": f.data,
            })
        })
        .collect();
    serde_json::to_writer(out, &array)?;
    Ok(())
}

fn render_summary<W: Write>(findings: &[Finding], out: &mut W) -> Result<()> {
    use std::collections::BTreeMap;
    let mut counts: BTreeMap<&'static str, usize> = BTreeMap::new();
    for f in findings {
        *counts.entry(f.rule).or_insert(0) += 1;
    }
    for (rule, count) in &counts {
        writeln!(out, "{}: {}", rule, count)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::lint::rule::Severity as Sev;

    fn write_card(vault: &std::path::Path, folder: &str, stem: &str, body: &str) {
        let dir = vault.join(folder);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("{}.md", stem)), body).unwrap();
    }

    fn cfg_for(vault: &std::path::Path) -> crate::config::ResolvedConfig {
        crate::config::ResolvedConfig {
            vault_root: vault.to_path_buf(),
            projects_path: None,
            project_path: None,
            lint: None,
            ignore: None,
        }
    }

    fn cfg_for_with_ignore(
        vault: &std::path::Path,
        ignore: crate::vault_ignore::VaultIgnore,
    ) -> crate::config::ResolvedConfig {
        crate::config::ResolvedConfig {
            vault_root: vault.to_path_buf(),
            projects_path: None,
            project_path: None,
            lint: None,
            ignore: Some(ignore),
        }
    }

    #[test]
    fn dispatcher_emits_orphan_card_with_vault_relative_path() {
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path();
        write_card(vault, "20 cards", "Foo", "---\ntype: card\n---\n");

        let cfg = cfg_for(vault);
        let mut buf = Vec::new();
        let exit = run_with_writer(&cfg, LintFormat::Text, &[], &mut buf).unwrap();
        let out = String::from_utf8(buf).unwrap();

        assert!(out.contains("orphan-card"), "missing rule name in: {}", out);
        assert!(out.contains("20 cards/Foo.md"), "missing rel path in: {}", out);
        let abs = vault.to_string_lossy().to_string();
        assert!(
            !out.contains(&abs),
            "output must not contain absolute vault path '{}': {}",
            abs,
            out
        );
        assert_eq!(exit, 0, "default severity is warn → exit 0");
    }

    #[test]
    fn dispatcher_returns_exit_1_when_rule_promoted_to_error() {
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path();
        write_card(vault, "20 cards", "Foo", "---\ntype: card\n---\n");

        let cfg = cfg_for(vault);
        let cli = vec!["orphan-card=error".to_string()];
        let mut buf = Vec::new();
        let exit = run_with_writer(&cfg, LintFormat::Text, &cli, &mut buf).unwrap();
        assert_eq!(exit, 1);
    }

    #[test]
    fn dispatcher_skips_rule_set_to_off() {
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path();
        write_card(vault, "20 cards", "Foo", "---\ntype: card\n---\n");

        let cfg = cfg_for(vault);
        let cli = vec!["orphan-card=off".to_string()];
        let mut buf = Vec::new();
        let _ = run_with_writer(&cfg, LintFormat::Text, &cli, &mut buf).unwrap();
        let out = String::from_utf8(buf).unwrap();
        assert!(
            !out.contains("orphan-card"),
            "orphan-card=off must suppress that rule, got: {}",
            out
        );
    }

    #[test]
    fn dispatcher_overwrites_finding_severity_with_effective() {
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path();
        write_card(vault, "20 cards", "Foo", "---\ntype: card\n---\n");

        let cfg = cfg_for(vault);
        let cli = vec!["orphan-card=error".to_string()];
        let mut buf = Vec::new();
        let _ = run_with_writer(&cfg, LintFormat::Text, &cli, &mut buf).unwrap();
        let out = String::from_utf8(buf).unwrap();
        assert!(out.starts_with("[error]"), "expected [error] prefix, got: {}", out);
        assert_ne!(Sev::Warn, Sev::Error);
    }

    // ── Step 6: JSON and Summary format tests ──────────────────────────────────

    /// Build a vault with an orphan card and a broken wikilink, run with JSON
    /// format, and verify the array shape.
    fn build_mixed_vault(vault: &std::path::Path) {
        // Orphan card: type=card, no backlinks pointing to it.
        write_card(vault, "20 cards", "Foo", "---\ntype: card\n---\n");
        // Source file containing a broken wikilink target.
        write_card(
            vault,
            "20 cards",
            "Src",
            "---\ntype: card\n---\n[[path/to/Quux]]",
        );
    }

    #[test]
    fn dispatcher_json_format_emits_array_with_stable_keys() {
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path();
        build_mixed_vault(vault);

        let cfg = cfg_for(vault);
        // Promote broken-wikilink to warn so it fires alongside orphan-card.
        let cli = vec!["broken-wikilink=warn".to_string()];
        let mut buf = Vec::new();
        run_with_writer(&cfg, LintFormat::Json, &cli, &mut buf).unwrap();
        let out = String::from_utf8(buf).unwrap();

        let arr: serde_json::Value = serde_json::from_str(&out)
            .unwrap_or_else(|e| panic!("JSON parse failed: {}\nraw: {}", e, out));
        assert!(arr.is_array(), "expected JSON array, got: {}", arr);

        let items = arr.as_array().unwrap();
        assert!(!items.is_empty(), "expected at least one finding");

        for item in items {
            for key in &["rule", "severity", "file", "message", "data"] {
                assert!(
                    item.get(key).is_some(),
                    "missing key '{}' in finding: {}",
                    key,
                    item
                );
            }
        }

        // At least one finding must be severity "warn" (orphan-card default or
        // broken-wikilink=warn override).
        let has_warn = items.iter().any(|i| i["severity"] == "warn");
        assert!(has_warn, "expected at least one warn-severity finding");
    }

    #[test]
    fn dispatcher_json_broken_wikilink_data_target_is_raw() {
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path();
        // Src.md contains [[path/to/Quux]]; neither Quux nor path/to/Quux exists.
        write_card(
            vault,
            "20 cards",
            "Src",
            "---\ntype: card\n---\n[[path/to/Quux]]",
        );

        let cfg = cfg_for(vault);
        let cli = vec!["broken-wikilink=warn".to_string()];
        let mut buf = Vec::new();
        run_with_writer(&cfg, LintFormat::Json, &cli, &mut buf).unwrap();
        let out = String::from_utf8(buf).unwrap();

        let arr: serde_json::Value = serde_json::from_str(&out).unwrap();
        let bw = arr
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["rule"] == "broken-wikilink")
            .expect("expected a broken-wikilink finding");

        assert_eq!(
            bw["data"]["target"], "path/to/Quux",
            "data.target must be raw verbatim target"
        );
    }

    #[test]
    fn dispatcher_json_file_paths_are_vault_relative() {
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path();
        build_mixed_vault(vault);

        let cfg = cfg_for(vault);
        let cli = vec!["broken-wikilink=warn".to_string()];
        let mut buf = Vec::new();
        run_with_writer(&cfg, LintFormat::Json, &cli, &mut buf).unwrap();
        let out = String::from_utf8(buf).unwrap();

        let arr: serde_json::Value = serde_json::from_str(&out).unwrap();
        let abs_prefix = vault.to_string_lossy().to_string();

        for item in arr.as_array().unwrap() {
            let file = item["file"].as_str().unwrap();
            assert!(
                !file.starts_with('/'),
                "file must not be absolute, got: {}",
                file
            );
            assert!(
                !file.contains(&abs_prefix),
                "file must not contain vault root '{}', got: {}",
                abs_prefix,
                file
            );
        }
    }

    #[test]
    fn dispatcher_summary_format_counts_per_rule() {
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path();
        // Three orphan cards; no broken wikilinks.
        write_card(vault, "20 cards", "A", "---\ntype: card\n---\n");
        write_card(vault, "20 cards", "B", "---\ntype: card\n---\n");
        write_card(vault, "20 cards", "C", "---\ntype: card\n---\n");

        let cfg = cfg_for(vault);
        let cli = vec!["broken-wikilink=off".to_string()];
        let mut buf = Vec::new();
        run_with_writer(&cfg, LintFormat::Summary, &cli, &mut buf).unwrap();
        let out = String::from_utf8(buf).unwrap();

        // orphan-card must appear with count 3.
        assert!(
            out.contains("orphan-card: 3"),
            "expected 'orphan-card: 3' in: {}",
            out
        );

        // Lines must be sorted alphabetically (spot-check by verifying the
        // summary doesn't contain something out-of-order when multiple rules fire).
        let lines: Vec<&str> = out.lines().collect();
        let mut sorted = lines.clone();
        sorted.sort();
        assert_eq!(lines, sorted, "summary lines must be sorted: {}", out);
    }

    #[test]
    fn dispatcher_summary_omits_zero_count_rules() {
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path();
        write_card(vault, "20 cards", "Foo", "---\ntype: card\n---\n");

        let cfg = cfg_for(vault);
        let cli = vec!["broken-wikilink=off".to_string()];
        let mut buf = Vec::new();
        run_with_writer(&cfg, LintFormat::Summary, &cli, &mut buf).unwrap();
        let out = String::from_utf8(buf).unwrap();

        assert!(
            !out.contains("broken-wikilink:"),
            "broken-wikilink=off must not appear in summary, got: {}",
            out
        );
    }

    #[test]
    fn dispatcher_summary_empty_when_no_findings() {
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path();
        // Empty vault: no markdown files at all.

        let cfg = cfg_for(vault);
        let mut buf = Vec::new();
        run_with_writer(&cfg, LintFormat::Summary, &[], &mut buf).unwrap();
        let out = String::from_utf8(buf).unwrap();

        assert!(out.is_empty(), "summary must be empty for empty vault, got: {:?}", out);
    }

    #[test]
    fn test_lint_respects_vaultignore() {
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path();

        // A card under 20 cards/ that links to a non-existent file (triggers broken-wikilink).
        write_card(
            vault,
            "20 cards",
            "note",
            "---\ntype: card\n---\n[[nonexistent-target]]",
        );

        // An orphan card under excluded/ that would trigger orphan-card if not ignored.
        write_card(vault, "excluded", "orphan", "---\ntype: card\n---\n");

        // Build VaultIgnore that excludes the `excluded` folder.
        let ignore = crate::vault_ignore::VaultIgnore::from_patterns(vec![
            std::path::PathBuf::from("excluded"),
        ]);
        let cfg = cfg_for_with_ignore(vault, ignore);

        let mut buf = Vec::new();
        run_with_writer(&cfg, LintFormat::Text, &["broken-wikilink=warn".to_string()], &mut buf).unwrap();
        let out = String::from_utf8(buf).unwrap();

        assert!(
            !out.contains("excluded/orphan.md"),
            "output must not mention excluded/orphan.md, got: {}",
            out
        );
    }
}
