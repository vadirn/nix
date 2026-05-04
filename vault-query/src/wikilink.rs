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

    // --- Failing tests: fenced code block suppression ---

    #[test]
    fn test_extract_skips_wikilink_in_backtick_fence() {
        let links = extract("```\n[[Note]]\n```");
        assert_eq!(links.len(), 0);
    }

    #[test]
    fn test_extract_skips_wikilink_in_tilde_fence() {
        let links = extract("~~~\n[[Note]]\n~~~");
        assert_eq!(links.len(), 0);
    }

    #[test]
    fn test_extract_skips_wikilink_in_fenced_bash_info_string() {
        let links = extract("```bash\n[[ -z $VAR ]] && echo hi\n```");
        assert_eq!(links.len(), 0);
    }

    #[test]
    fn test_extract_skips_bash_array_syntax_in_fence() {
        let content = "```bash\nif [[ \"$result\" == *\"text\"* ]]; then\n  echo ok\nfi\n```";
        let links = extract(content);
        assert_eq!(links.len(), 0);
    }

    #[test]
    fn test_extract_yields_wikilink_after_fence() {
        let content = "```\n[[Skip]]\n```\n[[Keep]]";
        let links = extract(content);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target, "Keep");
    }

    #[test]
    fn test_extract_line_number_correct_after_fence() {
        // "```\n[[Skip]]\n```\n[[Keep]]": fence is lines 1-3, [[Keep]] is on line 4.
        let content = "```\n[[Skip]]\n```\n[[Keep]]";
        let links = extract(content);
        assert_eq!(links[0].line, 4);
    }

    // --- Failing tests: inline code span suppression ---

    #[test]
    fn test_extract_skips_wikilink_in_single_backtick_span() {
        let links = extract("See `[[wikilink]]` for details.");
        assert_eq!(links.len(), 0);
    }

    #[test]
    fn test_extract_skips_wikilink_in_double_backtick_span() {
        let links = extract("See ``[[wikilink]]`` for details.");
        assert_eq!(links.len(), 0);
    }

    #[test]
    fn test_extract_yields_wikilink_outside_backtick_span() {
        let content = "`[[Skip]]` and [[Keep]]";
        let links = extract(content);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target, "Keep");
    }

    // --- Failing tests: YAML frontmatter suppression ---

    #[test]
    fn test_extract_skips_wikilink_in_frontmatter_yaml_string() {
        let content = "---\nfrictions:\n  - \"[[ -z $VAR ]] guard\"\n---\n[[Real]]";
        let links = extract(content);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target, "Real");
    }

    // --- Failing tests: CRLF and frontmatter line-offset arithmetic ---

    #[test]
    fn test_extract_handles_crlf_content() {
        let content = "line1\r\nline2 [[Note]]\r\nline3";
        let links = extract(content);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target, "Note");
        assert_eq!(links[0].line, 2);
    }

    #[test]
    fn test_extract_frontmatter_line_offset() {
        // 5-line frontmatter block:
        //   line 1: ---
        //   line 2: title: Foo
        //   line 3: tags:
        //   line 4:   - a
        //   line 5: ---
        //   line 6: [[Body]]
        //
        // frontmatter::body() returns "\n[[Body]]" (starts at the \n after closing ---).
        // The rewritten extract will feed body() to the parser and add a frontmatter_line_offset
        // equal to the number of newlines before the body slice. Those 5 newlines (one per
        // frontmatter line) plus the leading \n in the body slice shift [[Body]] to line 6.
        let content = "---\ntitle: Foo\ntags:\n  - a\n---\n[[Body]]";
        let links = extract(content);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target, "Body");
        // body() returns "\n[[Body]]"; within that slice [[Body]] is on line 2 (1-based).
        // frontmatter_line_offset = 5 (newlines in content before the body slice starts).
        // Reported line = offset + line-within-body = 5 + 1 = 6... but body slice starts
        // with \n so [[Body]] appears on line 2 of the body slice, offset adds 4 (newlines
        // before the \n that begins the body). Either way the expected absolute line is 6.
        assert_eq!(links[0].line, 6);
    }
}
