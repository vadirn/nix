use crate::frontmatter;
use crate::vault::VaultFile;
use anyhow::{Result, bail};
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

static IS_TRUTHY_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"^(!?)(\w+)\.isTruthy\(\)$"#).unwrap());

static QUOTED_STR_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#""([^"]*)""#).unwrap());

/// Whether a frontmatter field holds a value Obsidian counts as truthy.
///
/// Falsy is: the key absent, `null`, an empty string or sequence, `false`, and
/// `0`. Everything else is truthy. Reusing [`frontmatter::get_display`] collapses
/// all of those to a small set of strings — `Null` and an empty sequence both
/// render empty — so the check stays one match instead of a per-variant walk.
fn is_truthy(fm: &std::collections::BTreeMap<String, serde_yaml::Value>, field: &str) -> bool {
    let raw = frontmatter::get_display(fm, field);
    let v = raw.trim();
    !(v.is_empty() || v == "false" || v == "0")
}

/// Parse quoted strings from a containsAny argument list.
fn parse_contains_any_args(args: &str) -> Vec<String> {
    QUOTED_STR_RE
        .captures_iter(args)
        .map(|c| c[1].to_string())
        .collect()
}

/// Evaluate a single filter expression against a vault file.
///
/// An expression that matches no supported predicate is an error rather than a
/// silent pass-through: a typo'd or unsupported `.base` predicate would
/// otherwise match every file and return a plausible-but-wrong superset.
pub fn evaluate(expr: &str, file: &VaultFile, vault_root: &Path) -> Result<bool> {
    let expr = expr.trim().trim_matches('\'');

    // type == "value"
    if let Some(caps) = EQ_STR_RE.captures(expr) {
        let field = &caps[1];
        let value = &caps[2];
        return Ok(file.get_property(field) == value);
    }

    // field == true/false
    if let Some(caps) = EQ_BOOL_RE.captures(expr) {
        let field = &caps[1];
        let expected: bool = caps[2].parse().unwrap();
        return Ok(frontmatter::get_bool(&file.frontmatter, field) == Some(expected));
    }

    // file.inFolder("path")
    if let Some(caps) = IN_FOLDER_RE.captures(expr) {
        let folder = &caps[1];
        return Ok(file.in_folder(folder, vault_root));
    }

    // !file.inFolder("path")
    if let Some(caps) = NOT_IN_FOLDER_RE.captures(expr) {
        let folder = &caps[1];
        return Ok(!file.in_folder(folder, vault_root));
    }

    // field.containsAny("a", "b")
    if let Some(caps) = CONTAINS_ANY_RE.captures(expr) {
        let field = &caps[1];
        let args = parse_contains_any_args(&caps[2]);
        let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        return Ok(frontmatter::contains_any(&file.frontmatter, field, &refs));
    }

    // field.isTruthy() / !field.isTruthy()
    if let Some(caps) = IS_TRUTHY_RE.captures(expr) {
        let negated = !caps[1].is_empty();
        let field = &caps[2];
        return Ok(is_truthy(&file.frontmatter, field) != negated);
    }

    // field.length > N
    if let Some(caps) = LENGTH_RE.captures(expr) {
        let field = &caps[1];
        let threshold: usize = caps[2].parse().unwrap_or(0);
        return Ok(frontmatter::get_seq_len(&file.frontmatter, field) > threshold);
    }

    // Unknown/unsupported expression: surface it instead of matching everything.
    bail!("unsupported filter expression: {}", expr)
}

/// Evaluate a filter set (and/or) against a vault file.
pub fn evaluate_filter_set(
    filters: &super::FilterSet,
    file: &VaultFile,
    vault_root: &Path,
) -> Result<bool> {
    if !filters.and.is_empty() {
        for e in &filters.and {
            if !evaluate(e, file, vault_root)? {
                return Ok(false);
            }
        }
    }
    if !filters.or.is_empty() {
        let mut any = false;
        for e in &filters.or {
            if evaluate(e, file, vault_root)? {
                any = true;
                break;
            }
        }
        if !any {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Apply both base-level and view-level filters, plus an optional caller
/// predicate ANDed onto them.
///
/// `extra` is the slot for a filter a `.base` cannot declare because its
/// argument is only known at call time — `tickets --track <slug>` is the one
/// caller. It stays a Rust closure rather than a synthesized expression so the
/// expression vocabulary here keeps matching Obsidian's: an operator only this
/// engine understands would render in the CLI and silently fail in Obsidian.
pub fn apply(
    files: &[VaultFile],
    base_filters: &super::FilterSet,
    view_filters: &super::FilterSet,
    vault_root: &Path,
    extra: Option<&dyn Fn(&VaultFile) -> bool>,
) -> Result<Vec<VaultFile>> {
    let mut out = Vec::new();
    for f in files {
        if extra.is_none_or(|p| p(f))
            && evaluate_filter_set(base_filters, f, vault_root)?
            && evaluate_filter_set(view_filters, f, vault_root)?
        {
            out.push(f.clone());
        }
    }
    Ok(out)
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
            ..Default::default()
        }
    }

    #[test]
    fn test_string_equality() {
        let f = make_file(
            "cp1",
            vec![("type", Value::String("checkpoint".into()))],
            "41 projects/nix/cp1.md",
        );
        assert!(evaluate(r#"type == "checkpoint""#, &f, Path::new("/vault")).unwrap());
        assert!(!evaluate(r#"type == "project""#, &f, Path::new("/vault")).unwrap());
    }

    #[test]
    fn test_bool_equality() {
        let f = make_file("cp1", vec![("done", Value::Bool(false))], "cp1.md");
        assert!(evaluate("done == false", &f, Path::new("/vault")).unwrap());
        assert!(!evaluate("done == true", &f, Path::new("/vault")).unwrap());
    }

    #[test]
    fn test_in_folder() {
        let f = make_file("cp1", vec![], "41 projects/nix/cp1.md");
        assert!(
            evaluate(
                r#"file.inFolder("41 projects/nix")"#,
                &f,
                Path::new("/vault")
            )
            .unwrap()
        );
        assert!(!evaluate(r#"file.inFolder("20 cards")"#, &f, Path::new("/vault")).unwrap());
    }

    #[test]
    fn test_not_in_folder() {
        let f = make_file("cp1", vec![], "41 projects/nix/cp1.md");
        assert!(evaluate(r#"!file.inFolder("templates")"#, &f, Path::new("/vault")).unwrap());
        assert!(
            !evaluate(
                r#"!file.inFolder("41 projects/nix")"#,
                &f,
                Path::new("/vault")
            )
            .unwrap()
        );
    }

    #[test]
    fn test_contains_any() {
        let f = make_file(
            "p1",
            vec![("status", Value::String("in progress".into()))],
            "p1.md",
        );
        assert!(
            evaluate(
                r#"status.containsAny("in progress", "planned")"#,
                &f,
                Path::new("/vault")
            )
            .unwrap()
        );
        assert!(
            !evaluate(
                r#"status.containsAny("done", "archived")"#,
                &f,
                Path::new("/vault")
            )
            .unwrap()
        );
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
        assert!(evaluate("decisions.length > 0", &f, Path::new("/vault")).unwrap());

        let f2 = make_file("cp2", vec![], "cp2.md");
        assert!(!evaluate("decisions.length > 0", &f2, Path::new("/vault")).unwrap());
    }

    #[test]
    fn test_unknown_expression_errors() {
        // An unsupported predicate must error rather than silently matching
        // every file (the §4.1 pass-through-true bug).
        let f = make_file("cp1", vec![], "cp1.md");
        let err = evaluate("status =~ /foo/", &f, Path::new("/vault")).unwrap_err();
        assert!(err.to_string().contains("unsupported filter expression"));
    }

    #[test]
    fn test_unknown_expression_propagates_through_filter_set() {
        // The error surfaces through evaluate_filter_set, not just the leaf.
        let fs = super::super::FilterSet {
            and: vec!["bogus predicate".to_string()],
            or: vec![],
        };
        let f = make_file("cp1", vec![], "cp1.md");
        assert!(evaluate_filter_set(&fs, &f, Path::new("/vault")).is_err());
    }

    #[test]
    fn test_is_truthy() {
        // The Backlog view of Tickets.base selects on `!track.isTruthy()`, so an
        // absent, null, or empty `track` must read as falsy and a wikilink as truthy.
        let set = make_file(
            "t1",
            vec![(
                "track",
                Value::String("[[41 projects/nix/track-foo]]".into()),
            )],
            "41 projects/nix/ticket-a.md",
        );
        assert!(evaluate("track.isTruthy()", &set, Path::new("/vault")).unwrap());
        assert!(!evaluate("!track.isTruthy()", &set, Path::new("/vault")).unwrap());

        let null = make_file("t2", vec![("track", Value::Null)], "41 projects/nix/b.md");
        let empty = make_file(
            "t3",
            vec![("track", Value::String(String::new()))],
            "41 projects/nix/c.md",
        );
        let absent = make_file("t4", vec![], "41 projects/nix/d.md");
        for f in [&null, &empty, &absent] {
            assert!(!evaluate("track.isTruthy()", f, Path::new("/vault")).unwrap());
            assert!(evaluate("!track.isTruthy()", f, Path::new("/vault")).unwrap());
        }
    }

    #[test]
    fn test_is_truthy_false_and_zero_are_falsy() {
        let f = make_file(
            "t1",
            vec![
                ("draft", Value::Bool(false)),
                ("count", Value::Number(0.into())),
            ],
            "x.md",
        );
        assert!(!evaluate("draft.isTruthy()", &f, Path::new("/vault")).unwrap());
        assert!(!evaluate("count.isTruthy()", &f, Path::new("/vault")).unwrap());
    }

    #[test]
    fn test_apply_extra_predicate_ands_with_filters() {
        // The `--track` slot: a caller predicate narrows the view's result set
        // without touching the declared filters.
        let a = make_file(
            "a",
            vec![("type", Value::String("ticket".into()))],
            "41 projects/nix/ticket-a.md",
        );
        let b = make_file(
            "b",
            vec![("type", Value::String("ticket".into()))],
            "41 projects/nix/ticket-b.md",
        );
        let base = super::super::FilterSet {
            and: vec![r#"type == "ticket""#.to_string()],
            or: vec![],
        };
        let empty = super::super::FilterSet::default();
        let files = vec![a, b];

        let all = apply(&files, &base, &empty, Path::new("/vault"), None).unwrap();
        assert_eq!(all.len(), 2);

        let only_a = apply(
            &files,
            &base,
            &empty,
            Path::new("/vault"),
            Some(&|f: &VaultFile| f.name == "a"),
        )
        .unwrap();
        assert_eq!(only_a.len(), 1);
        assert_eq!(only_a[0].name, "a");
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
        assert!(evaluate_filter_set(&fs, &f, Path::new("/vault")).unwrap());

        let f2 = make_file("cp2", vec![], "cp2.md");
        assert!(!evaluate_filter_set(&fs, &f2, Path::new("/vault")).unwrap());
    }
}
