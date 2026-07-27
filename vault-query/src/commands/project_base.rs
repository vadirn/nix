//! The plumbing shared by every `.base` file that lives in a project folder.
//!
//! [`super::tracks`] and [`super::tickets`] are the same command twice: resolve
//! the project, join a file name, delegate to [`super::query`]; and to write one,
//! compute the project's vault-relative folder and drop a starter template there.
//! They differ in three constants, so the shared part is a value holding those
//! constants rather than a trait — the algorithm is identical, only its data
//! changes, and `const` construction keeps both commands' definitions free.

use anyhow::{Context, Result, bail};
use std::path::PathBuf;

use crate::config::ResolvedConfig;
use crate::output::Format;
use crate::vault::VaultFile;

/// A `.base` file in a project folder, backing one render subcommand and one
/// init subcommand.
pub struct ProjectBase {
    /// File name inside the project folder, e.g. `Tracks.base`.
    file_name: &'static str,
    /// The subcommand that writes it. Named in the not-found error rather than
    /// derived from `file_name`, so the hint the user is told to run stays
    /// greppable in this source.
    init_command: &'static str,
    /// Starter template, rendered for the project's vault-relative folder.
    template: fn(&str) -> String,
}

impl ProjectBase {
    pub const fn new(
        file_name: &'static str,
        init_command: &'static str,
        template: fn(&str) -> String,
    ) -> Self {
        Self {
            file_name,
            init_command,
            template,
        }
    }

    /// Render `view` of this base, ANDing `extra` onto its declared filters.
    ///
    /// See [`crate::base::filter::apply`] for why a filter parameterized at call
    /// time arrives as a closure rather than a synthesized expression.
    pub fn run(
        &self,
        cfg: &ResolvedConfig,
        view: &str,
        format: Format,
        extra: Option<&dyn Fn(&VaultFile) -> bool>,
    ) -> Result<()> {
        let base_path = self.path(cfg)?;
        if !base_path.is_file() {
            bail!(
                "no {} at {} (run `vault-query {}`)",
                self.file_name,
                base_path.display(),
                self.init_command
            );
        }
        super::query::run(&base_path, view, cfg, format, extra)
    }

    /// Write the starter template into the resolved project.
    ///
    /// The folder rendered into the template's `file.inFolder(…)` clause is the
    /// project's vault-relative path exactly as [`VaultFile::in_folder`] will
    /// later see it, with no separator rewriting: this tool runs on macOS only,
    /// where `to_string_lossy` already yields `/` separators and a backslash is
    /// an ordinary character in a file name. Rewriting `\` to `/` here would
    /// therefore change nothing except a folder whose name contains a backslash,
    /// which it would name as a folder that does not exist — emitting a filter
    /// that excludes the very files it was generated for.
    pub fn init(&self, cfg: &ResolvedConfig) -> Result<()> {
        let base_path = self.path(cfg)?;
        if base_path.exists() {
            bail!(
                "{} already exists at {}",
                self.file_name,
                base_path.display()
            );
        }

        let project_path = base_path.parent().expect("base path has a parent");
        let folder = project_path
            .strip_prefix(&cfg.vault_root)
            .with_context(|| {
                format!(
                    "project_path {} is not inside vault_root {}",
                    project_path.display(),
                    cfg.vault_root.display()
                )
            })?
            .to_string_lossy();

        std::fs::write(&base_path, (self.template)(&folder))
            .with_context(|| format!("writing {}", base_path.display()))?;
        println!("created {}", base_path.display());
        Ok(())
    }

    fn path(&self, cfg: &ResolvedConfig) -> Result<PathBuf> {
        let project_path = cfg
            .project_path
            .as_ref()
            .context("no project resolved (use --project <name> or add .vault.config.json)")?;
        Ok(project_path.join(self.file_name))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault_ignore::VaultIgnore;
    use tempfile::TempDir;

    fn template(folder: &str) -> String {
        format!("filters:\n  and:\n    - file.inFolder(\"{folder}\")\nviews: []\n")
    }

    const BASE: ProjectBase = ProjectBase::new("Widgets.base", "widgets-init", template);

    /// A config whose project sits at `<vault>/41 projects/nix`.
    fn cfg_for(tmp: &TempDir) -> ResolvedConfig {
        let project_path = tmp.path().join("41 projects/nix");
        std::fs::create_dir_all(&project_path).unwrap();
        ResolvedConfig {
            vault_root: tmp.path().to_path_buf(),
            projects_path: None,
            project_path: Some(project_path),
            log_project_path: String::new(),
            lint: None,
            consult: None,
            ignore: VaultIgnore::from_patterns(vec![]),
        }
    }

    #[test]
    fn init_writes_the_template_scoped_to_the_project_folder() {
        let tmp = TempDir::new().unwrap();
        let cfg = cfg_for(&tmp);
        BASE.init(&cfg).unwrap();

        let written =
            std::fs::read_to_string(tmp.path().join("41 projects/nix/Widgets.base")).unwrap();
        // The folder is vault-relative and slash-separated, since Obsidian reads
        // this same clause.
        assert!(written.contains(r#"file.inFolder("41 projects/nix")"#));
    }

    #[test]
    fn init_refuses_to_overwrite_an_existing_base() {
        let tmp = TempDir::new().unwrap();
        let cfg = cfg_for(&tmp);
        BASE.init(&cfg).unwrap();
        let err = BASE.init(&cfg).unwrap_err().to_string();
        assert!(err.contains("Widgets.base already exists"), "{err}");
    }

    #[test]
    fn run_names_the_init_subcommand_when_the_base_is_absent() {
        let tmp = TempDir::new().unwrap();
        let cfg = cfg_for(&tmp);
        let err = BASE
            .run(&cfg, "All", Format::Table, None)
            .unwrap_err()
            .to_string();
        assert!(err.contains("no Widgets.base"), "{err}");
        assert!(err.contains("vault-query widgets-init"), "{err}");
    }

    #[test]
    fn the_written_filter_selects_the_project_s_own_files() {
        // A backslash is an ordinary character in a macOS file name, so a folder
        // named `od\d` is a real folder. Rewriting the separator on the way into
        // `file.inFolder(...)` would name `od/d` instead — a folder that does not
        // exist — while `in_folder` still compares against the raw relative path,
        // so init would emit a filter matching none of its project's files.
        let tmp = TempDir::new().unwrap();
        let project_path = tmp.path().join(r"41 projects/od\d");
        std::fs::create_dir_all(&project_path).unwrap();
        let cfg = ResolvedConfig {
            project_path: Some(project_path.clone()),
            ..cfg_for(&tmp)
        };
        BASE.init(&cfg).unwrap();

        let base_file = crate::base::parse(&project_path.join("Widgets.base")).unwrap();
        let own_file = VaultFile {
            path: project_path.join("note.md"),
            ..Default::default()
        };
        assert!(
            crate::base::filter::evaluate_filter_set(&base_file.filters, &own_file, tmp.path())
                .unwrap()
        );
    }

    #[test]
    fn an_unresolved_project_is_an_error_not_a_vault_wide_scan() {
        let tmp = TempDir::new().unwrap();
        let mut cfg = cfg_for(&tmp);
        cfg.project_path = None;
        assert!(BASE.path(&cfg).is_err());
    }
}
