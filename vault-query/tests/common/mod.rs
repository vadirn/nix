//! Shared helpers for the vault-query integration test crates.
//!
//! Each `tests/*.rs` file is its own integration crate and pulls this module in via
//! `mod common;`. A given crate uses only a subset of these helpers, so the
//! module-wide `allow(dead_code)` keeps the unused remainder from warning per crate.
#![allow(dead_code)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Output};

use vault_query::config::ResolvedConfig;
use vault_query::vault::VaultFile;

/// The on-disk fixture vault shared by every integration crate.
pub fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/vault")
}

/// A `tests/fixtures/read/<name>` path (read/properties fixtures live here).
pub fn read_fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/read")
        .join(name)
}

/// The built `vault-query` binary under test.
pub fn cargo_bin() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_vault-query"))
}

/// A `ResolvedConfig` rooted at `vault_root` with defaults for everything else.
/// Replaces the inline `ResolvedConfig { .. }` literals the tests used to repeat.
pub fn cfg_for(vault_root: &Path) -> ResolvedConfig {
    let ignore = vault_query::vault_ignore::load(vault_root, false).unwrap();
    ResolvedConfig {
        vault_root: vault_root.to_path_buf(),
        projects_path: None,
        project_path: None,
        log_project_path: vault_query::config::DEFAULT_LOG_PROJECT_PATH.to_string(),
        lint: None,
        consult: None,
        ignore,
    }
}

/// Write a minimal layer-1 root config under `<home>/.config/vault/config.json`,
/// pinned to the fixture vault, carrying the given `consult` object. Collapses the
/// config-writer block the consult tests duplicated.
pub fn write_root_config(home: &Path, consult: serde_json::Value) {
    let cfg_dir = home.join(".config/vault");
    std::fs::create_dir_all(&cfg_dir).unwrap();
    std::fs::write(
        cfg_dir.join("config.json"),
        serde_json::json!({
            "vault_root": fixture_dir().to_str().unwrap(),
            "projects_path": "41 projects",
            "consult": consult,
        })
        .to_string(),
    )
    .unwrap();
}

/// Truncate `s` to at most `max` bytes without splitting a UTF-8 char boundary.
/// Used in failure messages that show a prefix of stdout.
pub fn truncate(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// A process killed by a signal carries no exit code. Treat that as a hard test
/// failure (a crash) rather than letting it masquerade as a normal exit.
fn assert_not_signal_killed(status: &ExitStatus) {
    if status.code().is_none() {
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            panic!(
                "vault-query was killed by signal {:?} (no exit code)",
                status.signal()
            );
        }
        #[cfg(not(unix))]
        panic!("vault-query terminated without an exit code");
    }
}

/// Convert a finished process into `(stdout, exit_code)`, failing loudly if the
/// process was signal-killed.
fn output_to_result(output: Output) -> (String, i32) {
    assert_not_signal_killed(&output.status);
    let stdout = String::from_utf8(output.stdout).unwrap();
    (stdout, output.status.code().unwrap_or(-1))
}

/// Run `vault-query <args...>` and return `(stdout, exit_code)`.
pub fn run_cmd(args: &[&str]) -> (String, i32) {
    let output = Command::new(cargo_bin())
        .args(args)
        .output()
        .expect("failed to run vault-query");
    output_to_result(output)
}

/// Run `vault-query consult --vault-root <fixture> <args...>`.
pub fn run_consult(args: &[&str]) -> (String, i32) {
    let mut cmd = Command::new(cargo_bin());
    cmd.args(["consult"])
        .arg("--vault-root")
        .arg(fixture_dir().to_str().unwrap());
    for a in args {
        cmd.arg(a);
    }
    output_to_result(cmd.output().expect("failed to run vault-query consult"))
}

/// Run `vault-query consult <query>` with a root config that sets `log_path`.
/// Returns `(stdout, exit_code)`.
pub fn run_consult_with_log(query: &str, log_file: &Path) -> (String, i32) {
    let tmp_home = tempfile::tempdir().unwrap();
    write_root_config(
        tmp_home.path(),
        serde_json::json!({ "log_path": log_file.to_str().unwrap() }),
    );
    let output = Command::new(cargo_bin())
        .env("HOME", tmp_home.path())
        .args(["consult", query])
        .output()
        .expect("failed to run vault-query consult");
    output_to_result(output)
}

/// Run `vault-query search --vault-root <fixture> <args...>`.
pub fn run_search(args: &[&str]) -> (String, i32) {
    let mut cmd = Command::new(cargo_bin());
    cmd.args(["search"])
        .arg("--vault-root")
        .arg(fixture_dir().to_str().unwrap());
    for a in args {
        cmd.arg(a);
    }
    output_to_result(cmd.output().expect("failed to run vault-query search"))
}

/// Run `vault-query list "20 cards" --vault-root <fixture> <args...>`.
pub fn run_list(args: &[&str]) -> (String, i32) {
    let mut cmd = Command::new(cargo_bin());
    cmd.args(["list", "20 cards"])
        .arg("--vault-root")
        .arg(fixture_dir().to_str().unwrap());
    for a in args {
        cmd.arg(a);
    }
    output_to_result(cmd.output().expect("failed to run vault-query list"))
}

/// Run `vault-query get --vault-root <fixture> <args...>`.
pub fn run_get(args: &[&str]) -> (String, i32) {
    let mut cmd = Command::new(cargo_bin());
    cmd.args(["get"])
        .arg("--vault-root")
        .arg(fixture_dir().to_str().unwrap());
    for a in args {
        cmd.arg(a);
    }
    output_to_result(cmd.output().expect("failed to run vault-query get"))
}

/// Construct a `VaultFile` directly over its public fields. `VaultFile`'s fields are
/// all `pub`, so the integration crates build one here with zero added library
/// surface — replacing the per-test inline literals.
pub fn vault_file(name: &str) -> VaultFileBuilder {
    VaultFileBuilder {
        path: PathBuf::from(format!("/vault/{name}.md")),
        name: name.to_string(),
        frontmatter: BTreeMap::new(),
        content: String::new(),
    }
}

pub struct VaultFileBuilder {
    path: PathBuf,
    name: String,
    frontmatter: BTreeMap<String, serde_yaml::Value>,
    content: String,
}

impl VaultFileBuilder {
    pub fn path(mut self, path: &str) -> Self {
        self.path = PathBuf::from(path);
        self
    }

    pub fn str_field(mut self, key: &str, value: &str) -> Self {
        self.frontmatter
            .insert(key.to_string(), serde_yaml::Value::String(value.to_string()));
        self
    }

    pub fn bool_field(mut self, key: &str, value: bool) -> Self {
        self.frontmatter
            .insert(key.to_string(), serde_yaml::Value::Bool(value));
        self
    }

    pub fn content(mut self, content: impl Into<String>) -> Self {
        self.content = content.into();
        self
    }

    pub fn build(self) -> VaultFile {
        VaultFile {
            path: self.path,
            name: self.name,
            frontmatter: self.frontmatter,
            frontmatter_error: None,
            content: self.content,
            ctime: None,
        }
    }
}
