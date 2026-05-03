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
    let files = crate::vault::scan(&cfg.vault_root)?;
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
}
