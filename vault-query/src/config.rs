use anyhow::{Context, Result};
use serde::Deserialize;
use std::path::{Path, PathBuf};

use crate::commands::lint::config::LintConfig;
use crate::vault_ignore::{self, VaultIgnore};

#[derive(Debug, Clone)]
pub struct ResolvedConfig {
    pub vault_root: PathBuf,
    pub projects_path: Option<String>,
    pub project_path: Option<PathBuf>,
    pub lint: Option<LintConfig>,
    pub ignore: VaultIgnore,
}

#[derive(Deserialize)]
struct RootConfig {
    vault_root: String,
    projects_path: String,
    #[serde(default)]
    lint: Option<LintConfig>,
}

#[derive(Deserialize)]
struct ProjectConfig {
    vault_root: String,
    project_path: String,
}

/// Resolve vault configuration by walking up from `start_dir` for a project config,
/// then falling back to `home_dir/.config/vault/config.json` for root config.
/// If `project_override` is given, it computes project_path from vault_root/projects_path/name.
/// If `vault_root_override` is given, it replaces vault_root from layered config; the root
/// config is still consulted for `projects_path` so `--vault-root` + `--project` honors it.
pub fn resolve(
    start_dir: &Path,
    home_dir: &Path,
    project_override: Option<&str>,
    vault_root_override: Option<&Path>,
    respect_user_patterns: bool,
) -> Result<ResolvedConfig> {
    let mut vault_root: Option<PathBuf> = None;
    let mut project_path: Option<PathBuf> = None;
    let mut projects_path: Option<String> = None;
    let mut lint_config: Option<LintConfig> = None;

    // Layer 1: Walk up from start_dir for project config (skipped when vault_root is overridden)
    if vault_root_override.is_none() {
        let mut dir = start_dir.to_path_buf();
        loop {
            let cfg_path = dir.join(".vault.config.json");
            if cfg_path.is_file() {
                let content = std::fs::read_to_string(&cfg_path)
                    .with_context(|| format!("reading {}", cfg_path.display()))?;
                let pc: ProjectConfig = serde_json::from_str(&content)
                    .with_context(|| format!("parsing {}", cfg_path.display()))?;
                vault_root = Some(PathBuf::from(&pc.vault_root));
                project_path = Some(PathBuf::from(&pc.project_path));
                break;
            }
            if !dir.pop() {
                break;
            }
        }
    }

    // Layer 2: Root config for vault_root and projects_path
    let root_cfg_path = home_dir.join(".config/vault/config.json");
    if root_cfg_path.is_file() {
        let content = std::fs::read_to_string(&root_cfg_path)
            .with_context(|| format!("reading {}", root_cfg_path.display()))?;
        let rc: RootConfig = serde_json::from_str(&content)
            .with_context(|| format!("parsing {}", root_cfg_path.display()))?;
        if vault_root.is_none() {
            vault_root = Some(PathBuf::from(&rc.vault_root));
        }
        projects_path = Some(rc.projects_path);
        lint_config = rc.lint;
    }

    // Layer 3: --vault-root takes precedence over both prior layers
    if let Some(vr) = vault_root_override {
        vault_root = Some(vr.to_path_buf());
        // Project_path from layered config is invalid under an overridden vault_root.
        project_path = None;
    }

    // Layer 4: --project flag overrides project_path
    if let Some(name) = project_override {
        let vr = vault_root
            .as_ref()
            .context("--project requires vault_root (set in root or project config)")?;
        let pp = projects_path.as_deref().unwrap_or("41 projects");
        project_path = Some(vr.join(pp).join(name));
    }

    let vault_root = vault_root.context(
        "no vault config found.\n\
         Create ~/.config/vault/config.json with:\n  \
         { \"vault_root\": \"/absolute/path/to/vault\", \"projects_path\": \"41 projects\" }",
    )?;

    let ignore = vault_ignore::load(&vault_root, respect_user_patterns)?;

    Ok(ResolvedConfig {
        vault_root,
        projects_path,
        project_path,
        lint: lint_config,
        ignore,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixtures_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/config")
    }

    #[test]
    fn test_root_config() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg_dir = tmp.path().join(".config/vault");
        std::fs::create_dir_all(&cfg_dir).unwrap();
        std::fs::copy(
            fixtures_dir().join("root.config.json"),
            cfg_dir.join("config.json"),
        )
        .unwrap();

        let config = resolve(Path::new("/nonexistent"), tmp.path(), None, None, true).unwrap();
        assert_eq!(config.vault_root, PathBuf::from("/tmp/test-vault"));
        assert_eq!(config.projects_path.as_deref(), Some("41 projects"));
        assert!(config.project_path.is_none());
    }

    #[test]
    fn test_project_config_walk_up() {
        let project_dir = fixtures_dir().join("project");
        // Walk up from project dir should find .vault.config.json
        let config = resolve(&project_dir, Path::new("/nonexistent-home"), None, None, true).unwrap();
        assert_eq!(config.vault_root, PathBuf::from("/tmp/test-vault"));
        assert_eq!(
            config.project_path,
            Some(PathBuf::from("/tmp/test-vault/41 projects/nix"))
        );
    }

    #[test]
    fn test_project_override() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg_dir = tmp.path().join(".config/vault");
        std::fs::create_dir_all(&cfg_dir).unwrap();
        std::fs::copy(
            fixtures_dir().join("root.config.json"),
            cfg_dir.join("config.json"),
        )
        .unwrap();

        let config = resolve(Path::new("/nonexistent"), tmp.path(), Some("nix"), None, true).unwrap();
        assert_eq!(
            config.project_path,
            Some(PathBuf::from("/tmp/test-vault/41 projects/nix"))
        );
    }

    #[test]
    fn test_no_config_error() {
        let result = resolve(
            Path::new("/nonexistent"),
            Path::new("/nonexistent-home"),
            None,
            None,
            true,
        );
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("no vault config found"));
    }

    #[test]
    fn test_project_override_without_vault_root_error() {
        let result = resolve(
            Path::new("/nonexistent"),
            Path::new("/nonexistent-home"),
            Some("nix"),
            None,
            true,
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_vault_root_override_with_project_uses_root_projects_path() {
        // --vault-root + --project should still consult root config for `projects_path`.
        // Configure root with projects_path = "custom/projects/dir"; vault_root is overridden
        // by the CLI flag. Resolved project_path must use the root's projects_path, not the
        // hardcoded "41 projects" fallback.
        let tmp = tempfile::tempdir().unwrap();
        let cfg_dir = tmp.path().join(".config/vault");
        std::fs::create_dir_all(&cfg_dir).unwrap();
        std::fs::write(
            cfg_dir.join("config.json"),
            r#"{"vault_root": "/should/be/ignored", "projects_path": "custom/projects/dir"}"#,
        )
        .unwrap();

        let override_root = PathBuf::from("/cli/override/vault");
        let config = resolve(
            Path::new("/nonexistent"),
            tmp.path(),
            Some("foo"),
            Some(&override_root),
            true,
        )
        .unwrap();
        assert_eq!(config.vault_root, override_root);
        assert_eq!(config.projects_path.as_deref(), Some("custom/projects/dir"));
        assert_eq!(
            config.project_path,
            Some(PathBuf::from("/cli/override/vault/custom/projects/dir/foo"))
        );
    }

    #[test]
    fn test_vault_root_override_falls_back_to_default_projects_path() {
        // No root config: --vault-root + --project falls back to "41 projects".
        let config = resolve(
            Path::new("/nonexistent"),
            Path::new("/nonexistent-home"),
            Some("foo"),
            Some(Path::new("/cli/vault")),
            true,
        )
        .unwrap();
        assert_eq!(config.vault_root, PathBuf::from("/cli/vault"));
        assert!(config.projects_path.is_none());
        assert_eq!(
            config.project_path,
            Some(PathBuf::from("/cli/vault/41 projects/foo"))
        );
    }

    #[test]
    fn lint_block_round_trips_through_resolved_config() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg_dir = tmp.path().join(".config/vault");
        std::fs::create_dir_all(&cfg_dir).unwrap();
        std::fs::write(
            cfg_dir.join("config.json"),
            r#"{
                "vault_root": "/tmp/test-vault",
                "projects_path": "41 projects",
                "lint": {
                    "rules": {
                        "orphan-card": "warn",
                        "broken-wikilink": "error"
                    }
                }
            }"#,
        )
        .unwrap();

        let config = resolve(Path::new("/nonexistent"), tmp.path(), None, None, true).unwrap();
        let lint = config.lint.expect("lint block should be present");
        assert_eq!(
            lint.rules.get("orphan-card"),
            Some(&crate::commands::lint::rule::Severity::Warn)
        );
        assert_eq!(
            lint.rules.get("broken-wikilink"),
            Some(&crate::commands::lint::rule::Severity::Error)
        );
    }

    #[test]
    fn lint_block_absent_gives_none() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg_dir = tmp.path().join(".config/vault");
        std::fs::create_dir_all(&cfg_dir).unwrap();
        std::fs::write(
            cfg_dir.join("config.json"),
            r#"{"vault_root": "/tmp/test-vault", "projects_path": "41 projects"}"#,
        )
        .unwrap();

        let config = resolve(Path::new("/nonexistent"), tmp.path(), None, None, true).unwrap();
        assert!(config.lint.is_none());
    }

    /// Build a temp vault root containing a `.vaultignore` with one pattern,
    /// and a separate home dir with a valid root config pointing elsewhere.
    /// The vault root is supplied via `vault_root_override` so `resolve` reads
    /// the `.vaultignore` from the temp vault rather than the config's path.
    fn make_vault_with_vaultignore() -> (tempfile::TempDir, tempfile::TempDir) {
        // vault_dir: the actual vault root with a .vaultignore
        let vault_dir = tempfile::tempdir().unwrap();
        std::fs::write(vault_dir.path().join(".vaultignore"), "excluded/\n").unwrap();

        // home_dir: a home directory with a root config (vault_root points somewhere,
        // but we override it via vault_root_override, so the path doesn't need to exist)
        let home_dir = tempfile::tempdir().unwrap();
        let cfg_dir = home_dir.path().join(".config/vault");
        std::fs::create_dir_all(&cfg_dir).unwrap();
        std::fs::write(
            cfg_dir.join("config.json"),
            r#"{"vault_root": "/tmp/irrelevant", "projects_path": "41 projects"}"#,
        )
        .unwrap();

        (vault_dir, home_dir)
    }

    #[test]
    fn test_resolve_respects_ignore_when_true() {
        let (vault_dir, home_dir) = make_vault_with_vaultignore();
        let user_pattern = std::path::PathBuf::from("excluded");
        let config = resolve(
            Path::new("/nonexistent"),
            home_dir.path(),
            None,
            Some(vault_dir.path()),
            true,
        )
        .unwrap();
        assert!(
            config.ignore.patterns.contains(&user_pattern),
            "expected user pattern to be loaded when respect_user_patterns=true"
        );
    }

    #[test]
    fn test_resolve_ignores_vaultignore_when_false() {
        let (vault_dir, home_dir) = make_vault_with_vaultignore();
        let user_pattern = std::path::PathBuf::from("excluded");
        let config = resolve(
            Path::new("/nonexistent"),
            home_dir.path(),
            None,
            Some(vault_dir.path()),
            false,
        )
        .unwrap();
        assert!(
            !config.ignore.patterns.contains(&user_pattern),
            "expected user pattern to be absent when respect_user_patterns=false"
        );
        // Only defaults (.git, .vaultignore) should be present.
        assert_eq!(
            config.ignore.patterns,
            vec![
                std::path::PathBuf::from(".git"),
                std::path::PathBuf::from(".vaultignore"),
            ]
        );
    }
}
