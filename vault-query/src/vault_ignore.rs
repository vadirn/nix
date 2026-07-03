use anyhow::Result;
use std::fs;
use std::path::{Path, PathBuf};

/// A set of vault-relative path prefixes that should be excluded from scans,
/// plus filename-suffix patterns (`*.ext`) matched at any depth.
#[derive(Debug, Clone)]
pub struct VaultIgnore {
    pub(crate) patterns: Vec<PathBuf>,
    pub(crate) suffixes: Vec<String>,
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
/// A line with no `/` that starts with `*.` (e.g. `*.tmp.md`) is instead a
/// filename-suffix pattern: it matches any file whose name ends with the
/// remainder (`.tmp.md`), at any depth.
pub fn load(vault_root: &Path, respect_user_patterns: bool) -> Result<VaultIgnore> {
    let mut patterns = default_patterns();
    let mut suffixes = Vec::new();

    if respect_user_patterns {
        let path = vault_root.join(".vaultignore");
        let text = match fs::read_to_string(&path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(e) => return Err(e.into()),
        };

        for line in text.lines().map(|l| l.trim()) {
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if !line.contains('/') && line.starts_with("*.") {
                suffixes.push(line[1..].to_string());
            } else {
                patterns.push(PathBuf::from(line.trim_end_matches('/')));
            }
        }
    }

    Ok(VaultIgnore { patterns, suffixes })
}

impl VaultIgnore {
    /// Returns true if `vault_relative` equals any prefix pattern or starts with
    /// one (component-aware: pattern `.claude` does NOT match
    /// `.claude-plans/foo.md`), or if its file name ends with any suffix
    /// pattern.
    pub fn excludes(&self, vault_relative: &Path) -> bool {
        self.patterns
            .iter()
            .any(|p| vault_relative == p || vault_relative.starts_with(p))
            || self.suffixes.iter().any(|suf| {
                vault_relative
                    .file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|name| name.ends_with(suf.as_str()))
            })
    }

    /// Construct a `VaultIgnore` directly from a list of path prefix patterns.
    /// Intended for tests; keeps visibility minimal.
    #[cfg(test)]
    pub(crate) fn from_patterns(patterns: Vec<PathBuf>) -> Self {
        VaultIgnore {
            patterns,
            suffixes: Vec::new(),
        }
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
            suffixes: Vec::new(),
        };
        assert!(ignore.excludes(Path::new("20 cards/draft.md")));
    }

    #[test]
    fn excludes_matches_descendants() {
        let ignore = VaultIgnore {
            patterns: vec![PathBuf::from(".claude")],
            suffixes: Vec::new(),
        };
        assert!(ignore.excludes(Path::new(".claude/foo.md")));
        assert!(ignore.excludes(Path::new(".claude/skills/bar.md")));
    }

    #[test]
    fn excludes_does_not_match_sibling_with_same_string_prefix() {
        let ignore = VaultIgnore {
            patterns: vec![PathBuf::from(".claude")],
            suffixes: Vec::new(),
        };
        // `.claude-plans/foo.md` shares the string prefix ".claude" but is a different component.
        assert!(!ignore.excludes(Path::new(".claude-plans/foo.md")));
    }

    #[test]
    fn excludes_returns_false_for_unmatched_paths() {
        let ignore = VaultIgnore {
            patterns: vec![PathBuf::from(".claude")],
            suffixes: Vec::new(),
        };
        assert!(!ignore.excludes(Path::new("notes/meeting.md")));
        assert!(!ignore.excludes(Path::new("cards/idea.md")));
    }

    #[test]
    fn load_parses_suffix_pattern_from_vaultignore() {
        let dir = TempDir::new().unwrap();
        make_vaultignore(&dir, "*.tmp.md\n.claude\n");
        let ignore = load(dir.path(), true).unwrap();
        assert_eq!(ignore.suffixes, vec![".tmp.md".to_string()]);
        assert_eq!(
            ignore.patterns,
            vec![
                PathBuf::from(".git"),
                PathBuf::from(".vaultignore"),
                PathBuf::from(".claude"),
            ]
        );
    }

    #[test]
    fn excludes_matches_suffix_pattern_at_any_depth() {
        let ignore = VaultIgnore {
            patterns: vec![],
            suffixes: vec![".tmp.md".to_string()],
        };
        assert!(ignore.excludes(Path::new("note.tmp.md")));
        assert!(ignore.excludes(Path::new("00 inbox/deep/nested/note.tmp.md")));
    }

    #[test]
    fn excludes_suffix_pattern_matches_filename_equal_to_the_suffix_itself() {
        // ends_with semantics: a name that IS the suffix (no distinguishing
        // prefix character) still counts as ending with it. Pinned behavior.
        let ignore = VaultIgnore {
            patterns: vec![],
            suffixes: vec![".tmp.md".to_string()],
        };
        assert!(ignore.excludes(Path::new(".tmp.md")));
    }

    #[test]
    fn excludes_suffix_pattern_does_not_match_shorter_name_missing_the_dot() {
        // "tmp.md" is shorter than the suffix ".tmp.md" and cannot end with it.
        let ignore = VaultIgnore {
            patterns: vec![],
            suffixes: vec![".tmp.md".to_string()],
        };
        assert!(!ignore.excludes(Path::new("tmp.md")));
        assert!(!ignore.excludes(Path::new("00 inbox/tmp.md")));
    }

    #[test]
    fn excludes_suffix_pattern_does_not_swallow_unrelated_extension() {
        let ignore = VaultIgnore {
            patterns: vec![],
            suffixes: vec![".tmp.md".to_string()],
        };
        assert!(!ignore.excludes(Path::new("x.md")));
    }

    #[test]
    fn excludes_prefix_patterns_unaffected_by_suffix_patterns() {
        let ignore = VaultIgnore {
            patterns: vec![PathBuf::from(".claude")],
            suffixes: vec![".tmp.md".to_string()],
        };
        assert!(ignore.excludes(Path::new(".claude/foo.md")));
        assert!(!ignore.excludes(Path::new(".claude-plans/foo.md")));
        assert!(ignore.excludes(Path::new("notes/draft.tmp.md")));
        assert!(!ignore.excludes(Path::new("notes/draft.md")));
    }
}
