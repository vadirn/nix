use anyhow::Result;
use std::fs;
use std::path::{Path, PathBuf};

/// A set of vault-relative path prefixes that should be excluded from scans.
#[derive(Debug, Clone)]
pub struct VaultIgnore {
    pub(crate) patterns: Vec<PathBuf>,
}

fn default_patterns() -> Vec<PathBuf> {
    vec![PathBuf::from(".git"), PathBuf::from(".vaultignore")]
}

/// Load exclusion patterns for `vault_root`.
///
/// Always starts with the built-in defaults (`.git` and `.vaultignore`).
/// If `respect_user_patterns` is true, also reads `<vault_root>/.vaultignore`.
/// A missing user file is silently ignored; other read errors propagate.
///
/// Syntax: one path prefix per line, `#` comments, blank lines ignored.
/// Trailing `/` is stripped so `.claude/` and `.claude` produce the same pattern.
pub fn load(vault_root: &Path, respect_user_patterns: bool) -> Result<VaultIgnore> {
    let mut patterns = default_patterns();

    if respect_user_patterns {
        let path = vault_root.join(".vaultignore");
        let text = match fs::read_to_string(&path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(e) => return Err(e.into()),
        };

        patterns.extend(
            text.lines()
                .map(|l| l.trim())
                .filter(|l| !l.is_empty() && !l.starts_with('#'))
                .map(|l| PathBuf::from(l.trim_end_matches('/'))),
        );
    }

    Ok(VaultIgnore { patterns })
}

impl VaultIgnore {
    /// Returns true if `vault_relative` equals any pattern or starts with one
    /// (component-aware: pattern `.claude` does NOT match `.claude-plans/foo.md`).
    pub fn excludes(&self, vault_relative: &Path) -> bool {
        self.patterns
            .iter()
            .any(|p| vault_relative == p || vault_relative.starts_with(p))
    }

    /// Construct a `VaultIgnore` directly from a list of path patterns.
    /// Intended for tests; keeps visibility minimal.
    pub(crate) fn from_patterns(patterns: Vec<PathBuf>) -> Self {
        VaultIgnore { patterns }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn make_vaultignore(dir: &TempDir, content: &str) {
        fs::write(dir.path().join(".vaultignore"), content).unwrap();
    }

    #[test]
    fn load_returns_defaults_when_absent() {
        let dir = TempDir::new().unwrap();
        let ignore = load(dir.path(), true).unwrap();
        assert!(ignore.excludes(Path::new(".git/foo.md")));
        assert!(ignore.excludes(Path::new(".vaultignore")));
        assert!(!ignore.excludes(Path::new("notes/meeting.md")));
    }

    #[test]
    fn load_returns_only_defaults_when_respect_user_patterns_false() {
        let dir = TempDir::new().unwrap();
        make_vaultignore(&dir, "extras/\n");
        let ignore = load(dir.path(), false).unwrap();
        assert!(!ignore.excludes(Path::new("extras/foo.md")));
        assert!(ignore.excludes(Path::new(".git/foo.md")));
    }

    #[test]
    fn load_merges_defaults_and_user_patterns() {
        let dir = TempDir::new().unwrap();
        make_vaultignore(&dir, "extras/\n");
        let ignore = load(dir.path(), true).unwrap();
        assert!(ignore.excludes(Path::new("extras/foo.md")));
        assert!(ignore.excludes(Path::new(".git/foo.md")));
        assert!(ignore.excludes(Path::new(".vaultignore")));
    }

    #[test]
    fn load_strips_comments_and_blank_lines() {
        let dir = TempDir::new().unwrap();
        make_vaultignore(
            &dir,
            "# this is a comment\n\n.claude\n# another comment\n.claude-plans\n",
        );
        let ignore = load(dir.path(), true).unwrap();
        assert_eq!(
            ignore.patterns,
            vec![
                PathBuf::from(".git"),
                PathBuf::from(".vaultignore"),
                PathBuf::from(".claude"),
                PathBuf::from(".claude-plans"),
            ]
        );
    }

    #[test]
    fn load_normalizes_trailing_slashes() {
        let dir = TempDir::new().unwrap();
        make_vaultignore(&dir, ".claude/\n.claude-plans/\n");
        let ignore = load(dir.path(), true).unwrap();
        // Trailing slash stripped: same as writing without slash.
        assert_eq!(
            ignore.patterns,
            vec![
                PathBuf::from(".git"),
                PathBuf::from(".vaultignore"),
                PathBuf::from(".claude"),
                PathBuf::from(".claude-plans"),
            ]
        );
    }

    #[test]
    fn excludes_matches_exact_path() {
        let ignore = VaultIgnore {
            patterns: vec![PathBuf::from("20 cards/draft.md")],
        };
        assert!(ignore.excludes(Path::new("20 cards/draft.md")));
    }

    #[test]
    fn excludes_matches_descendants() {
        let ignore = VaultIgnore {
            patterns: vec![PathBuf::from(".claude")],
        };
        assert!(ignore.excludes(Path::new(".claude/foo.md")));
        assert!(ignore.excludes(Path::new(".claude/skills/bar.md")));
    }

    #[test]
    fn excludes_does_not_match_sibling_with_same_string_prefix() {
        let ignore = VaultIgnore {
            patterns: vec![PathBuf::from(".claude")],
        };
        // `.claude-plans/foo.md` shares the string prefix ".claude" but is a different component.
        assert!(!ignore.excludes(Path::new(".claude-plans/foo.md")));
    }

    #[test]
    fn excludes_returns_false_for_unmatched_paths() {
        let ignore = VaultIgnore {
            patterns: vec![PathBuf::from(".claude")],
        };
        assert!(!ignore.excludes(Path::new("notes/meeting.md")));
        assert!(!ignore.excludes(Path::new("cards/idea.md")));
    }
}
