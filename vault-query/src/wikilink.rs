use regex::Regex;
use std::collections::HashMap;
use std::path::Path;
use std::sync::LazyLock;

static WIKILINK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[\[([^\]|]+)(?:\|([^\]]*))?\]\]").unwrap());

/// A parsed wikilink.
#[derive(Debug, Clone, PartialEq)]
pub struct Wikilink {
    pub target: String, // the link target (path or name)
    pub alias: Option<String>, // display alias if present
    pub line: u32, // 1-based line number where the link appears
}

/// Extract all wikilinks from content.
pub fn extract(content: &str) -> Vec<Wikilink> {
    let mut last_offset: usize = 0;
    let mut current_line: u32 = 1;
    let mut result = Vec::new();
    for cap in WIKILINK_RE.captures_iter(content) {
        let start = cap.get(0).unwrap().start();
        current_line += content[last_offset..start]
            .bytes()
            .filter(|&b| b == b'\n')
            .count() as u32;
        last_offset = start;
        result.push(Wikilink {
            target: cap[1].to_string(),
            alias: cap.get(2).map(|m| m.as_str().to_string()),
            line: current_line,
        });
    }
    result
}

/// Resolve a wikilink target to a note name (last path component, no extension).
pub fn resolve_name(target: &str) -> &str {
    let path = Path::new(target);
    path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(target)
}

/// Strip wikilink syntax from a string, keeping display text.
pub fn strip(text: &str) -> String {
    WIKILINK_RE
        .replace_all(text, |caps: &regex::Captures| {
            caps.get(2)
                .map(|m| m.as_str().to_string())
                .unwrap_or_else(|| {
                    let target = &caps[1];
                    resolve_name(target).to_string()
                })
        })
        .to_string()
}

/// Build an index mapping note names to their incoming links.
/// Key: note name (lowercase), Value: list of source file names that link to it.
pub fn build_backlink_index(
    files: &[crate::vault::VaultFile],
) -> HashMap<String, Vec<String>> {
    let mut index: HashMap<String, Vec<String>> = HashMap::new();
    for file in files {
        let links = extract(&file.content);
        for link in links {
            let target_name = resolve_name(&link.target).to_lowercase();
            index
                .entry(target_name)
                .or_default()
                .push(file.name.clone());
        }
    }
    index
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_simple() {
        let links = extract("See [[My Note]] for details.");
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target, "My Note");
        assert_eq!(links[0].alias, None);
    }

    #[test]
    fn test_extract_with_alias() {
        let links = extract("Check [[path/to/Note|display text]].");
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target, "path/to/Note");
        assert_eq!(links[0].alias, Some("display text".into()));
    }

    #[test]
    fn test_extract_multiple() {
        let links = extract("[[A]] and [[B|bee]] and [[C]]");
        assert_eq!(links.len(), 3);
    }

    #[test]
    fn test_strip() {
        assert_eq!(strip("[[Note]]"), "Note");
        assert_eq!(strip("[[path/Note|Display]]"), "Display");
        assert_eq!(strip("See [[A]] and [[B|b]]"), "See A and b");
    }

    #[test]
    fn test_resolve_name() {
        assert_eq!(resolve_name("41 projects/nix/Nix"), "Nix");
        assert_eq!(resolve_name("Simple"), "Simple");
    }

    #[test]
    fn test_extract_tracks_line() {
        let content = "line1 [[A]]\nline2 stuff\nline3 [[B]] and [[C]]";
        let links = extract(content);
        assert_eq!(links.len(), 3);
        assert_eq!(links[0].target, "A");
        assert_eq!(links[0].line, 1);
        assert_eq!(links[1].target, "B");
        assert_eq!(links[1].line, 3);
        assert_eq!(links[2].target, "C");
        assert_eq!(links[2].line, 3);
    }
}
