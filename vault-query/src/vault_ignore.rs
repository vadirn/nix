use anyhow::Result;
use std::fs;
use std::path::{Path, PathBuf};

/// A set of vault-relative path prefixes that should be excluded from scans.
#[derive(Debug, Clone)]
pub struct VaultIgnore {
    patterns: Vec<PathBuf>,
}

/// Read `<vault_root>/.vaultignore` and return a `VaultIgnore` if the file exists.
///
/// Syntax: one path prefix per line, `#` comments, blank lines ignored.
/// Trailing `/` is stripped so `.claude/` and `.claude` produce the same pattern.
pub fn load(vault_root: &Path) -> Result<Option<VaultIgnore>> {
    let path = vault_root.join(".vaultignore");
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };

    let patterns = text
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(|l| PathBuf::from(l.trim_end_matches('/')))
        .collect();

    Ok(Some(VaultIgnore { patterns }))
}

impl VaultIgnore {
    /// Returns true if `vault_relative` equals any pattern or starts with one
    /// (component-aware: pattern `.claude` does NOT match `.claude-plans/foo.md`).
    pub fn excludes(&self, vault_relative: &Path) -> bool {
        self.patterns
            .iter()
            .any(|p| vault_relative == p || vault_relative.starts_with(p))
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
    fn load_returns_none_when_absent() {
        let dir = TempDir::new().unwrap();
        let result = load(dir.path()).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn load_strips_comments_and_blank_lines() {
        let dir = TempDir::new().unwrap();
        make_vaultignore(
            &dir,
            "# this is a comment\n\n.claude\n# another comment\n.claude-plans\n",
        );
        let ignore = load(dir.path()).unwrap().unwrap();
        assert_eq!(
            ignore.patterns,
            vec![PathBuf::from(".claude"), PathBuf::from(".claude-plans")]
        );
    }

    #[test]
    fn load_normalizes_trailing_slashes() {
        let dir = TempDir::new().unwrap();
        make_vaultignore(&dir, ".claude/\n.claude-plans/\n");
        let ignore = load(dir.path()).unwrap().unwrap();
        // Trailing slash stripped: same as writing without slash.
        assert_eq!(
            ignore.patterns,
            vec![PathBuf::from(".claude"), PathBuf::from(".claude-plans")]
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
