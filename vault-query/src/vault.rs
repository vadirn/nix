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
    /// Frontmatter parse error message if YAML parsing failed; `None` on success or absent block.
    /// When `Some`, `frontmatter` is empty so other rules treat the file as untyped.
    pub frontmatter_error: Option<String>,
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

/// Walk `walk_root` and yield entries whose vault-relative path passes the
/// optional ignore filter.  Shared by [`scan`] and [`scan_assets`]; extension
/// filtering stays in the caller.
fn walk_entries<'a>(
    walk_root: &Path,
    vault_root: &'a Path,
    ignore: Option<&'a VaultIgnore>,
) -> impl Iterator<Item = walkdir::DirEntry> + 'a {
    WalkDir::new(walk_root)
        .follow_links(true)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(move |entry| {
            let path = entry.path();
            let vault_relative = path.strip_prefix(vault_root).unwrap_or(path);
            ignore.is_none_or(|ig| !ig.excludes(vault_relative))
        })
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
    for entry in walk_entries(walk_root, vault_root, ignore) {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let content = match fs::read_to_string(path) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("warning: skipping {} ({})", path.display(), e);
                continue;
            }
        };
        let (fm, frontmatter_error) = match frontmatter::parse(&content) {
            Ok(Some(fm)) => (fm, None),
            Ok(None) => (BTreeMap::new(), None),
            Err(e) => (BTreeMap::new(), Some(e.to_string())),
        };
        let name = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let ctime = entry.metadata().ok().and_then(|m| m.created().ok());
        files.push(VaultFile {
            path: path.to_path_buf(),
            name,
            frontmatter: fm,
            frontmatter_error,
            content,
            ctime,
        });
    }
    Ok(files)
}


/// Asset file extensions recognized by the vault (no leading dots, lowercased).
pub const ASSET_EXTENSIONS: &[&str] = &[
    "png", "jpeg", "jpg", "gif", "svg", "pdf", "canvas", "base", "tldraw",
];

/// A non-markdown asset file tracked in the vault.
#[derive(Debug, Clone)]
pub struct VaultAsset {
    /// Absolute path to the asset file.
    pub path: PathBuf,
    /// Basename including extension, e.g. `"Project scope.png"`.
    pub name: String,
}

/// Scan a directory for asset files (see [`ASSET_EXTENSIONS`]).
///
/// - `walk_root`: the directory to walk (may be a subfolder of the vault).
/// - `vault_root`: the vault root used to compute vault-relative paths for ignore matching.
/// - `ignore`: optional ignore filter; if `Some`, files whose vault-relative path is excluded are skipped.
pub fn scan_assets(
    walk_root: &Path,
    vault_root: &Path,
    ignore: Option<&VaultIgnore>,
) -> Result<Vec<VaultAsset>> {
    let mut assets = Vec::new();
    for entry in walk_entries(walk_root, vault_root, ignore) {
        let path = entry.path();
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_lowercase());
        if !ext.is_some_and(|e| ASSET_EXTENSIONS.contains(&e.as_str())) {
            continue;
        }
        let name = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        assets.push(VaultAsset {
            path: path.to_path_buf(),
            name,
        });
    }
    Ok(assets)
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

    // --- scan_assets tests ---

    #[test]
    fn test_scan_assets_finds_png_and_base() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("assets")).unwrap();
        std::fs::write(root.join("assets/Foo.png"), b"").unwrap();
        std::fs::create_dir_all(root.join("41 projects/nix")).unwrap();
        std::fs::write(root.join("41 projects/nix/Checkpoints.base"), b"").unwrap();

        let mut assets = scan_assets(root, root, None).unwrap();
        assets.sort_by(|a, b| a.name.cmp(&b.name));

        assert_eq!(assets.len(), 2, "expected 2 assets, got: {:?}", assets.iter().map(|a| &a.name).collect::<Vec<_>>());

        let foo = assets.iter().find(|a| a.name == "Foo.png").expect("Foo.png not found");
        assert_eq!(foo.path, root.join("assets/Foo.png"));

        let base = assets.iter().find(|a| a.name == "Checkpoints.base").expect("Checkpoints.base not found");
        assert_eq!(base.path, root.join("41 projects/nix/Checkpoints.base"));
    }

    #[test]
    fn test_scan_assets_skips_md() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        std::fs::write(root.join("note.md"), "# note\n").unwrap();

        let assets = scan_assets(root, root, None).unwrap();
        assert!(assets.is_empty(), "expected no assets, got: {:?}", assets.iter().map(|a| &a.name).collect::<Vec<_>>());
    }

    #[test]
    fn test_scan_assets_skips_unknown_extension() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        std::fs::write(root.join("file.xyz"), b"").unwrap();

        let assets = scan_assets(root, root, None).unwrap();
        assert!(assets.is_empty(), "expected no assets, got: {:?}", assets.iter().map(|a| &a.name).collect::<Vec<_>>());
    }

    #[test]
    fn test_scan_assets_skips_ignored() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("ignored")).unwrap();
        std::fs::write(root.join("ignored/Bar.png"), b"").unwrap();

        let ignore = VaultIgnore::from_patterns(vec![PathBuf::from("ignored")]);
        let assets = scan_assets(root, root, Some(&ignore)).unwrap();
        assert!(assets.is_empty(), "expected Bar.png to be ignored, got: {:?}", assets.iter().map(|a| &a.name).collect::<Vec<_>>());
    }

    #[test]
    fn test_scan_assets_handles_no_ignore() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        std::fs::write(root.join("image.jpg"), b"").unwrap();
        std::fs::write(root.join("note.md"), "# note\n").unwrap();

        let assets = scan_assets(root, root, None).unwrap();
        assert_eq!(assets.len(), 1, "expected only image.jpg, got: {:?}", assets.iter().map(|a| &a.name).collect::<Vec<_>>());
        assert_eq!(assets[0].name, "image.jpg");
    }
}
