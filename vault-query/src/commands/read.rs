//! `read FILE [ADDRESS]`: the vault-facing wrapper over the [`mdread`] engine.
//!
//! The reader itself — heading tree, addressing, fold/unfold, rendering — lives
//! in the standalone `mdread` crate, which knows nothing about vaults. This
//! wrapper adds the two vault concerns the general reader must not carry:
//!
//! 1. **Target resolution.** A literal path that exists wins; then a bare
//!    vault-relative pointer (`read "20 cards/Foo.md"`) against the configured
//!    vault root; then the argument is treated as a *name fragment* and resolved
//!    through the same [`crate::slug::resolve_paths`] index `get` uses, so
//!    `read "Skill vs note"` works without a `get` round-trip first.
//! 2. **The vault dialect.** Vault content never indents headings, and the
//!    historical scanner rejected any leading whitespace, so headings read with
//!    [`mdread::HeadingRule::StrictColumn1`] rather than CommonMark's 0–3-space
//!    allowance. Links count as [`mdread::LinkRule::Wikilinks`]: the vault's
//!    `links:` figure measures its own note graph, which URLs are not part of.

use std::path::{Path, PathBuf};

use anyhow::Result;

use crate::config::ResolvedConfig;
use crate::output::TextJson;

/// An existing file named directly: a literal/absolute path, else the path taken
/// as vault-relative. `None` when neither names a real file, which is the signal
/// to try name-fragment resolution.
fn existing_path(file: &Path, vault_root: Option<&Path>) -> Option<PathBuf> {
    if file.exists() {
        return Some(file.to_path_buf());
    }
    let root = vault_root?;
    let joined = root.join(file);
    joined.exists().then_some(joined)
}

/// Resolve what to read: a real path first, then a vault name fragment.
///
/// Fragment resolution runs only when the argument names no existing file, so a
/// path caller never pays for a vault scan and never risks a surprise match. An
/// unresolvable argument is returned unchanged, letting the read error name what
/// the caller actually asked for.
fn resolve_target(file: &Path, cfg: Option<&ResolvedConfig>) -> Result<PathBuf> {
    if let Some(found) = existing_path(file, cfg.map(|c| c.vault_root.as_path())) {
        return Ok(found);
    }
    let Some(cfg) = cfg else {
        return Ok(file.to_path_buf());
    };

    let fragment = file.to_string_lossy();
    let matches = crate::slug::resolve_paths(&fragment, cfg)?;
    match matches.len() {
        1 => Ok(cfg.vault_root.join(&matches[0])),
        // Ambiguity is the caller's to settle: list the candidates rather than
        // silently reading whichever sorted first.
        n if n > 1 => {
            let mut msg = format!("Ambiguous name '{}'; {} matches:", fragment, n);
            for m in &matches {
                msg.push_str(&format!("\n  {}", m));
            }
            Err(anyhow::anyhow!(msg))
        }
        _ => Ok(file.to_path_buf()),
    }
}

/// Map the crate-wide output format onto the reader's own two-variant enum.
fn reader_format(format: TextJson) -> mdread::TextJson {
    match format {
        TextJson::Text => mdread::TextJson::Text,
        TextJson::Json => mdread::TextJson::Json,
    }
}

/// How the vault reads Markdown, as against the reader's CommonMark default.
const VAULT_DIALECT: mdread::Dialect = mdread::Dialect {
    headings: mdread::HeadingRule::StrictColumn1,
    links: mdread::LinkRule::Wikilinks,
};

pub fn run(
    file: &Path,
    cfg: Option<&ResolvedConfig>,
    address: Option<&str>,
    depth: Option<usize>,
    full: bool,
    threshold: Option<usize>,
    format: TextJson,
) -> Result<()> {
    let resolved = resolve_target(file, cfg)?;
    mdread::run(
        &resolved,
        address,
        depth,
        full,
        threshold,
        reader_format(format),
        VAULT_DIALECT,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A config rooted at `vault_root`, with everything else defaulted, so the
    /// fragment resolver can scan a temp vault.
    fn cfg_for(vault_root: &Path) -> ResolvedConfig {
        ResolvedConfig {
            vault_root: vault_root.to_path_buf(),
            projects_path: None,
            project_path: None,
            log_project_path: crate::config::DEFAULT_LOG_PROJECT_PATH.to_string(),
            lint: None,
            consult: None,
            ignore: crate::vault_ignore::load(vault_root, false).unwrap(),
        }
    }

    #[test]
    fn existing_literal_path_wins_over_vault_root() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("here.md");
        std::fs::write(&file, "# x\n").unwrap();
        // Even with a vault root configured, an existing literal path is used.
        let other = tempfile::tempdir().unwrap();
        assert_eq!(existing_path(&file, Some(other.path())), Some(file));
    }

    #[test]
    fn missing_path_falls_back_to_vault_root() {
        let vault = tempfile::tempdir().unwrap();
        let rel = Path::new("20 cards/Foo.md");
        let abs = vault.path().join(rel);
        std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
        std::fs::write(&abs, "# x\n").unwrap();
        assert_eq!(existing_path(rel, Some(vault.path())), Some(abs));
    }

    #[test]
    fn names_no_real_file_is_none() {
        let vault = tempfile::tempdir().unwrap();
        let rel = Path::new("nope/missing.md");
        assert_eq!(existing_path(rel, Some(vault.path())), None);
        assert_eq!(existing_path(rel, None), None);
    }

    #[test]
    fn unresolvable_argument_is_returned_unchanged() {
        let vault = tempfile::tempdir().unwrap();
        let rel = Path::new("nope/missing.md");
        // No path, no fragment match: the caller's argument comes back so the
        // read error names what was asked for.
        assert_eq!(resolve_target(rel, Some(&cfg_for(vault.path()))).unwrap(), rel);
        assert_eq!(resolve_target(rel, None).unwrap(), rel);
    }

    #[test]
    fn name_fragment_resolves_to_its_entry() {
        let vault = tempfile::tempdir().unwrap();
        let abs = vault.path().join("20 cards/Impureim sandwich.md");
        std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
        std::fs::write(&abs, "---\ntype: card\n---\n\n# x\n").unwrap();
        // A bare name — no path, no extension — resolves through the same index
        // `get` uses, collapsing the get→read round-trip.
        let got = resolve_target(Path::new("Impureim sandwich"), Some(&cfg_for(vault.path()))).unwrap();
        assert_eq!(got, abs);
    }

    #[test]
    fn existing_path_wins_over_a_fragment_of_the_same_name() {
        // A real file named like a vault entry is still read literally: path
        // resolution runs first, so fragment matching never shadows a real file.
        let vault = tempfile::tempdir().unwrap();
        let entry = vault.path().join("20 cards/Foo.md");
        std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
        std::fs::write(&entry, "# vault copy\n").unwrap();

        let cwd_file = vault.path().join("Foo.md");
        std::fs::write(&cwd_file, "# literal copy\n").unwrap();
        assert_eq!(
            resolve_target(&cwd_file, Some(&cfg_for(vault.path()))).unwrap(),
            cwd_file
        );
    }

    #[test]
    fn ambiguous_fragment_errors_and_lists_candidates() {
        let vault = tempfile::tempdir().unwrap();
        for folder in ["20 cards", "30 notes"] {
            let abs = vault.path().join(folder).join("Twin.md");
            std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
            std::fs::write(&abs, "# x\n").unwrap();
        }
        let err = resolve_target(Path::new("Twin"), Some(&cfg_for(vault.path()))).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("Ambiguous"), "got: {msg}");
        assert!(msg.contains("20 cards/Twin.md"), "got: {msg}");
        assert!(msg.contains("30 notes/Twin.md"), "got: {msg}");
    }

    #[test]
    fn format_maps_onto_the_reader_enum() {
        assert_eq!(reader_format(TextJson::Text), mdread::TextJson::Text);
        assert_eq!(reader_format(TextJson::Json), mdread::TextJson::Json);
    }
}
