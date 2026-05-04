use anyhow::Result;
use serde_yaml::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

use crate::frontmatter;
use crate::vault_ignore::VaultIgnore;

/// A parsed markdown file with its frontmatter and metadata.
#[derive(Debug, Clone, Default)]
pub struct VaultFile {
    pub path: PathBuf,
    pub name: String, // filename without extension
    pub frontmatter: BTreeMap<String, Value>,
    pub content: String,
    pub ctime: Option<std::time::SystemTime>,
}

impl VaultFile {
    /// Get a frontmatter property as a display string.
    pub fn get_property(&self, key: &str) -> String {
        frontmatter::get_display(&self.frontmatter, key)
    }

    /// Get the relative path from vault root.
    pub fn relative_path(&self, vault_root: &Path) -> String {
        self.path
            .strip_prefix(vault_root)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| self.path.to_string_lossy().to_string())
    }

    /// Check if this file is in the given folder (relative to vault root).
    pub fn in_folder(&self, folder: &str, vault_root: &Path) -> bool {
        let rel = self.relative_path(vault_root);
        rel.starts_with(folder)
    }

}

/// Resolve an optional subfolder relative to vault root.
pub fn resolve_root(vault_root: &Path, subfolder: Option<&Path>) -> PathBuf {
    match subfolder {
        Some(f) => vault_root.join(f),
        None => vault_root.to_path_buf(),
    }
}

/// Scan a directory for .md files and parse their frontmatter.
///
/// - `walk_root`: the directory to walk (may be a subfolder of the vault).
/// - `vault_root`: the vault root used to compute vault-relative paths for ignore matching.
/// - `ignore`: optional ignore filter; if `Some`, files whose vault-relative path is excluded are skipped.
pub fn scan(
    walk_root: &Path,
    vault_root: &Path,
    ignore: Option<&VaultIgnore>,
) -> Result<Vec<VaultFile>> {
    let mut files = Vec::new();
    for entry in WalkDir::new(walk_root)
        .follow_links(true)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let vault_relative = path.strip_prefix(vault_root).unwrap_or(path);
        if let Some(ig) = ignore {
            if ig.excludes(vault_relative) {
                continue;
            }
        }
        let content = match fs::read_to_string(path) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("warning: skipping {} ({})", path.display(), e);
                continue;
            }
        };
        let fm = match frontmatter::parse(&content) {
            Ok(Some(fm)) => fm,
            Ok(None) => BTreeMap::new(),
            Err(e) => {
                eprintln!(
                    "warning: skipping {} (bad frontmatter: {})",
                    path.display(),
                    e
                );
                BTreeMap::new()
            }
        };
        let name = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let ctime = fs::metadata(path).ok().and_then(|m| m.created().ok());
        files.push(VaultFile {
            path: path.to_path_buf(),
            name,
            frontmatter: fm,
            content,
            ctime,
        });
    }
    Ok(files)
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault_ignore::VaultIgnore;
    use tempfile::TempDir;

    fn fixture_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/vault")
    }

    /// Build a temp vault with `keep.md` at root and `excluded/skip.md` in a subfolder.
    fn build_simple_vault() -> TempDir {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        std::fs::write(root.join("keep.md"), "# keep\n").unwrap();
        std::fs::create_dir_all(root.join("excluded")).unwrap();
        std::fs::write(root.join("excluded/skip.md"), "# skip\n").unwrap();
        tmp
    }

    #[test]
    fn test_scan_with_ignore_skips_matched_files() {
        let tmp = build_simple_vault();
        let dir = tmp.path();
        let ignore = VaultIgnore::from_patterns(vec![PathBuf::from("excluded")]);
        let files = scan(dir, dir, Some(&ignore)).unwrap();
        assert_eq!(files.len(), 1, "expected only keep.md, got: {:?}", files.iter().map(|f| &f.path).collect::<Vec<_>>());
        assert!(files[0].name == "keep", "expected keep.md, got: {}", files[0].name);
    }

    #[test]
    fn test_scan_with_none_returns_all_files() {
        let tmp = build_simple_vault();
        let dir = tmp.path();
        let files = scan(dir, dir, None).unwrap();
        assert_eq!(files.len(), 2, "expected both files, got: {:?}", files.iter().map(|f| &f.path).collect::<Vec<_>>());
    }

    #[test]
    fn test_scan_fixtures() {
        let dir = fixture_dir();
        let files = scan(&dir, &dir, None).unwrap();
        assert!(files.len() >= 3);

        let checkpoints: Vec<_> = files
            .iter()
            .filter(|f| f.get_property("type") == "checkpoint")
            .collect();
        assert_eq!(checkpoints.len(), 3);
    }

    #[test]
    fn test_in_folder() {
        let dir = fixture_dir();
        let files = scan(&dir, &dir, None).unwrap();
        let f = files.iter().find(|f| f.name == "checkpoint-001").unwrap();
        assert!(f.in_folder("41 projects/nix", &dir));
        assert!(!f.in_folder("20 cards", &dir));
    }
}
