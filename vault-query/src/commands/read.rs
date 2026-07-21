//! `read FILE [ADDRESS]`: the vault-facing wrapper over the [`mdread`] engine.
//!
//! The reader itself — heading tree, addressing, fold/unfold, rendering — lives
//! in the standalone `mdread` crate, which knows nothing about vaults. This
//! wrapper adds the two vault concerns the general reader must not carry:
//!
//! 1. **Vault-relative path fallback.** A literal path that exists wins; a bare
//!    vault-relative pointer (`read "20 cards/Foo.md"`) resolves against the
//!    configured vault root so it works from any cwd.
//! 2. **The stricter heading rule.** Vault content never indents headings, and
//!    the historical scanner rejected any leading whitespace, so the vault reads
//!    with [`mdread::HeadingRule::StrictColumn1`] rather than CommonMark's
//!    0–3-space allowance.

use std::path::{Path, PathBuf};

use anyhow::Result;

use crate::output::TextJson;

/// Resolve the path to read. A literal/absolute path that exists wins; if it
/// does not exist and a `vault_root` is configured, fall back to
/// `vault_root.join(file)`. When neither resolves, return the original so the
/// read error names what the caller asked for.
fn resolve_read_path(file: &Path, vault_root: Option<&Path>) -> PathBuf {
    if file.exists() {
        return file.to_path_buf();
    }
    if let Some(root) = vault_root {
        let joined = root.join(file);
        if joined.exists() {
            return joined;
        }
    }
    file.to_path_buf()
}

/// Map the crate-wide output format onto the reader's own two-variant enum.
fn reader_format(format: TextJson) -> mdread::TextJson {
    match format {
        TextJson::Text => mdread::TextJson::Text,
        TextJson::Json => mdread::TextJson::Json,
    }
}

pub fn run(
    file: &Path,
    vault_root: Option<&Path>,
    address: Option<&str>,
    depth: Option<usize>,
    full: bool,
    threshold: Option<usize>,
    format: TextJson,
) -> Result<()> {
    let resolved = resolve_read_path(file, vault_root);
    mdread::run(
        &resolved,
        address,
        depth,
        full,
        threshold,
        reader_format(format),
        mdread::HeadingRule::StrictColumn1,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn existing_literal_path_wins_over_vault_root() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("here.md");
        std::fs::write(&file, "# x\n").unwrap();
        // Even with a vault root configured, an existing literal path is used.
        let other = tempfile::tempdir().unwrap();
        assert_eq!(resolve_read_path(&file, Some(other.path())), file);
    }

    #[test]
    fn missing_path_falls_back_to_vault_root() {
        let vault = tempfile::tempdir().unwrap();
        let rel = Path::new("20 cards/Foo.md");
        let abs = vault.path().join(rel);
        std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
        std::fs::write(&abs, "# x\n").unwrap();
        assert_eq!(resolve_read_path(rel, Some(vault.path())), abs);
    }

    #[test]
    fn unresolvable_path_is_returned_unchanged() {
        let vault = tempfile::tempdir().unwrap();
        let rel = Path::new("nope/missing.md");
        // Neither cwd-literal nor vault-relative exists: the caller's path comes
        // back so the read error names what was asked for.
        assert_eq!(resolve_read_path(rel, Some(vault.path())), rel.to_path_buf());
        assert_eq!(resolve_read_path(rel, None), rel.to_path_buf());
    }

    #[test]
    fn format_maps_onto_the_reader_enum() {
        assert_eq!(reader_format(TextJson::Text), mdread::TextJson::Text);
        assert_eq!(reader_format(TextJson::Json), mdread::TextJson::Json);
    }
}
