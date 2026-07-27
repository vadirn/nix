//! The plumbing shared by every `.base` file that lives in a project folder.
//!
//! [`super::tracks`] and [`super::tickets`] are the same command twice: resolve
//! the project, join a file name, delegate to [`super::query`]; and to write one,
//! compute the project's vault-relative folder and drop a starter template there.
//! They differ in three constants, so the shared part is a value holding those
//! constants rather than a trait — the algorithm is identical, only its data
//! changes, and `const` construction keeps both commands' definitions free.

use anyhow::{Context, Result, bail};
use std::path::{Path, PathBuf};

use crate::config::ResolvedConfig;
use crate::output::Format;
use crate::vault::VaultFile;

/// A `.base` file in a project folder, backing one render subcommand and one
/// init subcommand.
///
/// Built by naming every field — `ProjectBase { file_name: …, init_command: …,
/// template: … }` — and never through a positional constructor: two of the three
/// fields are `&'static str`, so a positional call would let a transposition
/// type-check into a wrong path plus a wrong hint. A struct literal is still
/// `const`, so the two call sites keep their `const BASE`.
pub struct ProjectBase {
    /// File name inside the project folder, e.g. `Tracks.base`.
    pub file_name: &'static str,
    /// The subcommand that writes it. Named in the not-found error rather than
    /// derived from `file_name`, so the hint the user is told to run stays
    /// greppable in this source.
    pub init_command: &'static str,
    /// Starter template, rendered for the project's vault-relative folder.
    pub template: fn(&str) -> String,
}

impl ProjectBase {
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
        let project_path = self.project_path(cfg)?;
        let base_path = project_path.join(self.file_name);
        if base_path.exists() {
            bail!(
                "{} already exists at {}",
                self.file_name,
                base_path.display()
            );
        }

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

    /// The resolved project folder, or the error naming both ways to resolve one.
    ///
    /// Held separate from [`Self::path`] so [`Self::init`] can read the folder it
    /// needs directly instead of recovering it from the joined path.
    fn project_path<'a>(&self, cfg: &'a ResolvedConfig) -> Result<&'a Path> {
        cfg.project_path
            .as_deref()
            .context("no project resolved (use --project <name> or add .vault.config.json)")
    }

    /// Where this base lives, whether or not the file exists yet.
    fn path(&self, cfg: &ResolvedConfig) -> Result<PathBuf> {
        Ok(self.project_path(cfg)?.join(self.file_name))
    }
}

/// Assert that `template` renders a `.base` declaring exactly `expected_views`,
/// in order, and that every filter expression it declares is one
/// [`crate::base::filter::evaluate`] recognises.
///
/// Shared by the [`super::tracks`] and [`super::tickets`] test modules because
/// their templates are string literals no compiler checks: since `evaluate`
/// bails on an unrecognised expression rather than passing it through, a typo in
/// a template is a runtime error on a command with no other guard.
#[cfg(test)]
pub fn assert_template_views(template: fn(&str) -> String, expected_views: &[&str]) {
    use crate::base;
    use tempfile::TempDir;

    let tmp = TempDir::new().unwrap();
    let vault_root = tmp.path();
    let path = vault_root.join("Template.base");
    std::fs::write(&path, template("41 projects/nix")).unwrap();
    let base_file = base::parse(&path).unwrap();

    let names: Vec<&str> = base_file.views.iter().map(|v| v.name.as_str()).collect();
    assert_eq!(names, expected_views);

    // A file the filters can be run against; the verdict is irrelevant, only
    // that every expression is understood.
    let probe = VaultFile {
        path: vault_root.join("41 projects/nix/probe.md"),
        ..Default::default()
    };
    base::filter::evaluate_filter_set(&base_file.filters, &probe, vault_root)
        .expect("base-level filters");
    for view in &base_file.views {
        base::filter::evaluate_filter_set(&view.filters, &probe, vault_root)
            .unwrap_or_else(|e| panic!("view {}: {e}", view.name));
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

    const BASE: ProjectBase = ProjectBase {
        file_name: "Widgets.base",
        init_command: "widgets-init",
        template,
    };

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
