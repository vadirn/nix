//! Template-derived per-type frontmatter schemas.
//!
//! Templates are the source of truth for which frontmatter fields a type may
//! carry (`allowed`) and, for picker fields, which values are legal (`enums`).
//! `build_type_schemas` gathers templates from TWO sources — the `ctx.files`
//! scan and a direct `read_dir` of `vault_root/templates` — unions each
//! template's keys into its type's `allowed` set, and unions each non-empty
//! scalar-sequence picker into `enums[key]`. A universal meta-set of
//! cross-cutting infrastructure fields is then unioned into every type's
//! `allowed`, so genuinely shared fields never read as drift.
//!
//! The disk read exists because `.vaultignore` can exclude `templates/` from the
//! scan (the real vault does). When that happens `ctx.files` yields no templates,
//! the schema map comes out empty, and both rules skip every entry. Reading the
//! templates directory straight off disk bypasses `.vaultignore`, so the schema
//! is populated regardless. The two sources are unioned; a template seen in both
//! folds idempotently (set unions), and a vault that does NOT ignore `templates/`
//! (or a test that passes templates via `ctx.files`) keeps working unchanged.
//!
//! A type with no template gets NO entry in the returned map: both the
//! `unknown-field` and `invalid-enum-value` rules skip entries whose type is
//! absent here, so an un-templated type (e.g. `context`, `spike`, `bookmark`) is
//! never flagged.

use crate::commands::lint::rule::LintContext;
use crate::frontmatter;
use serde_yaml::Value;
use std::collections::{BTreeMap, BTreeSet};

/// Cross-cutting infrastructure fields legal on every typed entry, independent of
/// its template. Unioned into every schema's `allowed` set so shared metadata
/// (provenance, relations, supersession, aliases) never reads as unknown drift.
const UNIVERSAL_FIELDS: &[&str] = &[
    "type",
    "template",
    "created",
    "updated",
    "related",
    "superseded",
    "superseded_by",
    "supersedes",
    "aliases",
];

/// The allowed fields and picker enums for one `type:` value, derived from that
/// type's template(s).
#[derive(Debug, Clone, Default)]
pub struct TypeSchema {
    /// Frontmatter keys legal on an entry of this type: the union of every
    /// template's keys plus the universal meta-set.
    pub allowed: BTreeSet<String>,
    /// Per-key legal value sets, derived from template picker fields (non-empty
    /// scalar sequences). A key absent here has no enum constraint.
    pub enums: BTreeMap<String, BTreeSet<String>>,
}

/// Build per-type schemas from the vault's templates.
///
/// Templates come from two sources, unioned: the `ctx.files` scan and a direct
/// `read_dir` of `vault_root/templates` (which bypasses `.vaultignore`). For
/// every template (`frontmatter::is_template`) of type T, union its keys into
/// `allowed`, and — for each key whose value is a non-empty scalar `Sequence` —
/// the scalar strings into `enums[key]`. Finally union the universal meta-set
/// into every type's `allowed`. A type with no template gets no entry.
pub fn build_type_schemas(ctx: &LintContext) -> BTreeMap<String, TypeSchema> {
    let mut schemas: BTreeMap<String, TypeSchema> = BTreeMap::new();

    // Source 1: the scan. Present for vaults that do not ignore `templates/`
    // and for the unit tests that inject templates via the `files` vec.
    for file in ctx.files {
        fold_template(&mut schemas, &file.frontmatter);
    }

    // Source 2: the templates directory read straight off disk. This bypasses
    // `.vaultignore`, so a vault that excludes `templates/` from the scan (the
    // real one does) still gets its schema populated. Absent or unreadable
    // directory / files contribute nothing — no panic.
    fold_disk_templates(&mut schemas, &ctx.vault_root.join("templates"));

    // Union the universal meta-set into every templated type.
    for schema in schemas.values_mut() {
        for field in UNIVERSAL_FIELDS {
            schema.allowed.insert((*field).to_string());
        }
    }

    schemas
}

/// Fold one template's parsed frontmatter into `schemas`. No-op unless the
/// frontmatter is marked `template: true` and carries a non-empty `type`. Set
/// unions make this idempotent, so folding the same template twice (once per
/// source) is safe.
fn fold_template(schemas: &mut BTreeMap<String, TypeSchema>, fm: &BTreeMap<String, Value>) {
    if !frontmatter::is_template(fm) {
        return;
    }
    let type_val = frontmatter::get_display(fm, "type");
    if type_val.is_empty() {
        return;
    }

    let schema = schemas.entry(type_val).or_default();
    for (key, value) in fm {
        schema.allowed.insert(key.clone());

        // A non-empty sequence of scalars is a picker: its items are the
        // legal values for this field. An empty sequence (e.g. `requires: []`)
        // is a collection field, not a picker — allowed, but no enum.
        if let Value::Sequence(seq) = value {
            if seq.is_empty() {
                continue;
            }
            let mut options: BTreeSet<String> = BTreeSet::new();
            for item in seq {
                if let Some(s) = scalar_string(item) {
                    options.insert(s);
                }
            }
            if !options.is_empty() {
                schema.enums.entry(key.clone()).or_default().extend(options);
            }
        }
    }
}

/// Read every `*.md` file in `dir` off disk, parse its frontmatter, and fold it
/// into `schemas` via [`fold_template`]. Bypasses `.vaultignore` entirely — this
/// is the path that recovers the schema when the scan skips `templates/`.
///
/// Every failure mode degrades to contributing nothing: a missing or unreadable
/// directory (`read_dir` errors), an unreadable file, or unparseable / absent
/// frontmatter is skipped silently rather than panicking.
fn fold_disk_templates(schemas: &mut BTreeMap<String, TypeSchema>, dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return; // absent or unreadable directory → no disk-sourced schemas
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue; // unreadable file → skip
        };
        // `parse` → Ok(Some(fm)) on a valid block; Err (bad YAML) or Ok(None)
        // (no frontmatter) both contribute nothing.
        if let Ok(Some(fm)) = frontmatter::parse(&content) {
            fold_template(schemas, &fm);
        }
    }
}

/// Render a scalar YAML value as its string form, or `None` for non-scalars
/// (`Null`, `Sequence`, `Mapping`, `Tagged`). Used to lift picker options out of
/// a template sequence.
fn scalar_string(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_yaml::Value;
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    fn make_file(name: &str, path: &str, fields: &[(&str, Value)]) -> crate::vault::VaultFile {
        let mut fm = BTreeMap::new();
        for (k, v) in fields {
            fm.insert(k.to_string(), v.clone());
        }
        crate::vault::VaultFile {
            name: name.to_string(),
            path: PathBuf::from(path),
            frontmatter: fm,
            ..Default::default()
        }
    }

    #[test]
    fn templated_type_gets_allowed_enums_and_universal_meta() {
        let template = make_file(
            "Ticket",
            "/vault/templates/Ticket.md",
            &[
                ("type", Value::String("ticket".into())),
                ("template", Value::Bool(true)),
                ("slug", Value::String(String::new())),
                (
                    "status",
                    Value::Sequence(vec![
                        Value::String("open".into()),
                        Value::String("done".into()),
                    ]),
                ),
                // Empty sequence: allowed field, but NO enum.
                ("requires", Value::Sequence(vec![])),
            ],
        );
        let files = vec![template];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let schemas = build_type_schemas(&ctx);
        let ticket = schemas.get("ticket").expect("ticket type has a schema");

        // Template keys are allowed.
        assert!(ticket.allowed.contains("slug"));
        assert!(ticket.allowed.contains("status"));
        assert!(ticket.allowed.contains("requires"));
        // Universal meta is allowed.
        assert!(ticket.allowed.contains("related"));
        assert!(ticket.allowed.contains("created"));

        // status is a non-empty picker → enum.
        let status = ticket.enums.get("status").expect("status is an enum");
        assert!(status.contains("open"));
        assert!(status.contains("done"));
        // requires is an empty sequence → NO enum.
        assert!(!ticket.enums.contains_key("requires"));
    }

    #[test]
    fn untemplated_type_gets_no_entry() {
        // Only a card template exists; a spike type has no template.
        let template = make_file(
            "Card",
            "/vault/templates/Card.md",
            &[
                ("type", Value::String("card".into())),
                ("template", Value::Bool(true)),
                ("description", Value::String(String::new())),
            ],
        );
        let files = vec![template];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);

        let schemas = build_type_schemas(&ctx);
        assert!(schemas.contains_key("card"));
        assert!(!schemas.contains_key("spike"));
    }
}
