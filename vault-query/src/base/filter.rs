use crate::frontmatter;
use crate::vault::VaultFile;
use regex::Regex;
use std::path::Path;
use std::sync::LazyLock;

// Filter expression patterns
static EQ_STR_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"^(\w+)\s*==\s*"([^"]*)"$"#).unwrap());

static EQ_BOOL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"^(\w+)\s*==\s*(true|false)$"#).unwrap());

static IN_FOLDER_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"^file\.inFolder\("([^"]*)"\)$"#).unwrap());

static NOT_IN_FOLDER_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"^!file\.inFolder\("([^"]*)"\)$"#).unwrap());

static CONTAINS_ANY_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"^(\w+)\.containsAny\((.+)\)$"#).unwrap());

static LENGTH_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"^(\w+)\.length\s*>\s*(\d+)$"#).unwrap());

/// Parse quoted strings from a containsAny argument list.
fn parse_contains_any_args(args: &str) -> Vec<String> {
    let re = Regex::new(r#""([^"]*)""#).unwrap();
    re.captures_iter(args)
        .map(|c| c[1].to_string())
        .collect()
}

/// Evaluate a single filter expression against a vault file.
pub fn evaluate(expr: &str, file: &VaultFile, vault_root: &Path) -> bool {
    let expr = expr.trim().trim_matches('\'');

    // type == "value"
    if let Some(caps) = EQ_STR_RE.captures(expr) {
        let field = &caps[1];
        let value = &caps[2];
        return file.get_property(field) == value;
    }

    // field == true/false
    if let Some(caps) = EQ_BOOL_RE.captures(expr) {
        let field = &caps[1];
        let expected: bool = caps[2].parse().unwrap();
        return frontmatter::get_bool(&file.frontmatter, field) == Some(expected);
    }

    // file.inFolder("path")
    if let Some(caps) = IN_FOLDER_RE.captures(expr) {
        let folder = &caps[1];
        return file.in_folder(folder, vault_root);
    }

    // !file.inFolder("path")
    if let Some(caps) = NOT_IN_FOLDER_RE.captures(expr) {
        let folder = &caps[1];
        return !file.in_folder(folder, vault_root);
    }

    // field.containsAny("a", "b")
    if let Some(caps) = CONTAINS_ANY_RE.captures(expr) {
        let field = &caps[1];
        let args = parse_contains_any_args(&caps[2]);
        let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        return frontmatter::contains_any(&file.frontmatter, field, &refs);
    }

    // field.length > N
    if let Some(caps) = LENGTH_RE.captures(expr) {
        let field = &caps[1];
        let threshold: usize = caps[2].parse().unwrap_or(0);
        return frontmatter::get_seq_len(&file.frontmatter, field) > threshold;
    }

    // Unknown expression: pass through
    true
}

/// Evaluate a filter set (and/or) against a vault file.
pub fn evaluate_filter_set(
    filters: &super::FilterSet,
    file: &VaultFile,
    vault_root: &Path,
) -> bool {
    if !filters.and.is_empty() {
        if !filters.and.iter().all(|e| evaluate(e, file, vault_root)) {
            return false;
        }
    }
    if !filters.or.is_empty() {
        if !filters.or.iter().any(|e| evaluate(e, file, vault_root)) {
            return false;
        }
    }
    true
}

/// Apply both base-level and view-level filters.
pub fn apply(
    files: &[VaultFile],
    base_filters: &super::FilterSet,
    view_filters: &super::FilterSet,
    vault_root: &Path,
) -> Vec<VaultFile> {
    files
        .iter()
        .filter(|f| evaluate_filter_set(base_filters, f, vault_root))
        .filter(|f| evaluate_filter_set(view_filters, f, vault_root))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::VaultFile;
    use serde_yaml::Value;
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    fn make_file(name: &str, props: Vec<(&str, Value)>, rel_path: &str) -> VaultFile {
        let mut fm = BTreeMap::new();
        for (k, v) in props {
            fm.insert(k.to_string(), v);
        }
        VaultFile {
            path: PathBuf::from(format!("/vault/{}", rel_path)),
            name: name.to_string(),
            frontmatter: fm,
            content: String::new(),
        }
    }

    #[test]
    fn test_string_equality() {
        let f = make_file(
            "cp1",
            vec![("type", Value::String("checkpoint".into()))],
            "41 projects/nix/cp1.md",
        );
        assert!(evaluate(r#"type == "checkpoint""#, &f, Path::new("/vault")));
        assert!(!evaluate(r#"type == "project""#, &f, Path::new("/vault")));
    }

    #[test]
    fn test_bool_equality() {
        let f = make_file("cp1", vec![("done", Value::Bool(false))], "cp1.md");
        assert!(evaluate("done == false", &f, Path::new("/vault")));
        assert!(!evaluate("done == true", &f, Path::new("/vault")));
    }

    #[test]
    fn test_in_folder() {
        let f = make_file("cp1", vec![], "41 projects/nix/cp1.md");
        assert!(evaluate(
            r#"file.inFolder("41 projects/nix")"#,
            &f,
            Path::new("/vault")
        ));
        assert!(!evaluate(
            r#"file.inFolder("20 cards")"#,
            &f,
            Path::new("/vault")
        ));
    }

    #[test]
    fn test_not_in_folder() {
        let f = make_file("cp1", vec![], "41 projects/nix/cp1.md");
        assert!(evaluate(
            r#"!file.inFolder("templates")"#,
            &f,
            Path::new("/vault")
        ));
        assert!(!evaluate(
            r#"!file.inFolder("41 projects/nix")"#,
            &f,
            Path::new("/vault")
        ));
    }

    #[test]
    fn test_contains_any() {
        let f = make_file(
            "p1",
            vec![("status", Value::String("in progress".into()))],
            "p1.md",
        );
        assert!(evaluate(
            r#"status.containsAny("in progress", "planned")"#,
            &f,
            Path::new("/vault")
        ));
        assert!(!evaluate(
            r#"status.containsAny("done", "archived")"#,
            &f,
            Path::new("/vault")
        ));
    }

    #[test]
    fn test_length() {
        let f = make_file(
            "cp1",
            vec![(
                "decisions",
                Value::Sequence(vec![Value::String("did something".into())]),
            )],
            "cp1.md",
        );
        assert!(evaluate("decisions.length > 0", &f, Path::new("/vault")));

        let f2 = make_file("cp2", vec![], "cp2.md");
        assert!(!evaluate("decisions.length > 0", &f2, Path::new("/vault")));
    }

    #[test]
    fn test_or_filter_set() {
        let fs = super::super::FilterSet {
            and: vec![],
            or: vec![
                "decisions.length > 0".to_string(),
                "frictions.length > 0".to_string(),
            ],
        };
        let f = make_file(
            "cp1",
            vec![(
                "frictions",
                Value::Sequence(vec![Value::String("trouble".into())]),
            )],
            "cp1.md",
        );
        assert!(evaluate_filter_set(&fs, &f, Path::new("/vault")));

        let f2 = make_file("cp2", vec![], "cp2.md");
        assert!(!evaluate_filter_set(&fs, &f2, Path::new("/vault")));
    }
}
