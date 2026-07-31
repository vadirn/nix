//! Lint command integration tests.

mod common;
use common::*;

use vault_query::commands::lint::format::LintFormat;

#[test]
fn test_lint_asset_wikilinks_resolve() {
    let tmp = tempfile::tempdir().unwrap();
    let vault = tmp.path();

    // Place two asset files.
    std::fs::create_dir_all(vault.join("assets")).unwrap();
    std::fs::write(vault.join("assets/diagram.png"), b"").unwrap();
    std::fs::create_dir_all(vault.join("41 projects/nix")).unwrap();
    std::fs::write(vault.join("41 projects/nix/Checkpoints.base"), b"").unwrap();

    // Note that wikilinks to both a bare asset name and a path-qualified asset.
    std::fs::write(
        vault.join("note.md"),
        "See [[diagram.png]] and [[41 projects/nix/Checkpoints.base]].\n",
    )
    .unwrap();

    let cfg = cfg_for(vault);

    let mut buf = Vec::new();
    vault_query::commands::lint::run_with_writer(
        &cfg,
        LintFormat::Json,
        &["broken-wikilink=error".to_string()],
        &mut buf,
    )
    .unwrap();

    let out = String::from_utf8(buf).unwrap();
    let arr: serde_json::Value = serde_json::from_str(&out).unwrap();
    let broken: Vec<_> = arr
        .as_array()
        .unwrap()
        .iter()
        .filter(|f| f["rule"] == "broken-wikilink")
        .collect();

    assert!(
        broken.is_empty(),
        "expected zero broken-wikilink findings for asset wikilinks, got: {:#?}",
        broken
    );
}

#[test]
fn test_lint_schema_rules_flag_drift_against_ticket_template() {
    let tmp = tempfile::tempdir().unwrap();
    let vault = tmp.path();

    // Template establishes the ticket schema: allowed fields + `status`/`kind`
    // pickers.
    std::fs::create_dir_all(vault.join("templates")).unwrap();
    std::fs::write(
        vault.join("templates/Ticket.md"),
        "---\n\
         type: ticket\n\
         template: true\n\
         slug: \"\"\n\
         description: \"\"\n\
         status:\n  - open\n  - in-progress\n  - done\n\
         project: \"\"\n\
         kind:\n  - feature\n  - fix\n  - chore\n\
         created: \"\"\n\
         updated: \"\"\n\
         ---\n",
    )
    .unwrap();

    // A ticket with a bad `status` value and an unknown field, but all required
    // fields present (including `kind`).
    std::fs::create_dir_all(vault.join("41 projects/demo")).unwrap();
    std::fs::write(
        vault.join("41 projects/demo/ticket-thing.md"),
        "---\n\
         type: ticket\n\
         slug: thing\n\
         description: do the thing\n\
         status: wip\n\
         project: demo\n\
         kind: feature\n\
         created: 2026-07-31\n\
         updated: 2026-07-31\n\
         extra_field: oops\n\
         ---\n",
    )
    .unwrap();

    let cfg = cfg_for(vault);
    let mut buf = Vec::new();
    vault_query::commands::lint::run_with_writer(&cfg, LintFormat::Json, &[], &mut buf).unwrap();
    let out = String::from_utf8(buf).unwrap();
    let arr: serde_json::Value = serde_json::from_str(&out).unwrap();
    let items = arr.as_array().unwrap();

    let find = |rule: &str| -> Vec<&serde_json::Value> {
        items.iter().filter(|f| f["rule"] == rule).collect()
    };

    // Unknown field flagged.
    let unknown = find("unknown-field");
    assert_eq!(
        unknown.len(),
        1,
        "expected one unknown-field, got: {:#?}",
        unknown
    );
    assert_eq!(
        unknown[0]["message"],
        "unknown frontmatter field 'extra_field' for type 'ticket'"
    );

    // Invalid enum value flagged, options rendered sorted.
    let enum_bad = find("invalid-enum-value");
    assert_eq!(
        enum_bad.len(),
        1,
        "expected one invalid-enum-value, got: {:#?}",
        enum_bad
    );
    assert_eq!(
        enum_bad[0]["message"],
        "frontmatter field 'status' value 'wip' not one of: done, in-progress, open"
    );

    // `kind` is present, so it must not appear as a missing required field.
    let missing = find("missing-required-field");
    assert!(
        missing.is_empty(),
        "expected no missing-required-field, got: {:#?}",
        missing
    );
}

/// Production regression: a `.vaultignore` that excludes `templates/` hides the
/// templates from the scan, so a scan-only schema builder finds no templates,
/// builds an empty schema map, and both `unknown-field` and `invalid-enum-value`
/// go silent. The schema builder must read `templates/` off disk (bypassing
/// `.vaultignore`) so the two rules still fire. This test FAILS against the
/// pre-fix, scan-only builder and passes once the disk read is in place.
#[test]
fn test_lint_schema_rules_fire_when_vaultignore_excludes_templates() {
    let tmp = tempfile::tempdir().unwrap();
    let vault = tmp.path();

    // The production condition: `.vaultignore` excludes the templates folder, so
    // `crate::vault::scan` never yields the template files.
    std::fs::write(vault.join(".vaultignore"), "templates/\n").unwrap();

    // Ticket template with the `status`/`kind` pickers and the `requires`/`track`
    // fields — the schema source of truth, reachable only off disk here.
    std::fs::create_dir_all(vault.join("templates")).unwrap();
    std::fs::write(
        vault.join("templates/Ticket.md"),
        "---\n\
         type: ticket\n\
         template: true\n\
         slug: \"\"\n\
         description: \"\"\n\
         status:\n  - open\n  - in-progress\n  - done\n\
         project: \"\"\n\
         kind:\n  - feature\n  - fix\n  - chore\n\
         requires: []\n\
         track: \"\"\n\
         created: \"\"\n\
         updated: \"\"\n\
         ---\n",
    )
    .unwrap();

    // A ticket carrying BOTH an unknown field (`bogus`) and an out-of-set enum
    // value (`kind: banana`), with every required field present.
    std::fs::create_dir_all(vault.join("41 projects/demo")).unwrap();
    std::fs::write(
        vault.join("41 projects/demo/ticket-thing.md"),
        "---\n\
         type: ticket\n\
         slug: thing\n\
         description: do the thing\n\
         status: open\n\
         project: demo\n\
         kind: banana\n\
         created: 2026-07-31\n\
         updated: 2026-07-31\n\
         bogus: x\n\
         ---\n",
    )
    .unwrap();

    let cfg = cfg_for(vault);
    let mut buf = Vec::new();
    vault_query::commands::lint::run_with_writer(&cfg, LintFormat::Json, &[], &mut buf).unwrap();
    let out = String::from_utf8(buf).unwrap();
    let arr: serde_json::Value = serde_json::from_str(&out).unwrap();
    let items = arr.as_array().unwrap();

    let find = |rule: &str| -> Vec<&serde_json::Value> {
        items.iter().filter(|f| f["rule"] == rule).collect()
    };

    // Both rules fire despite the scan skipping `templates/` — proof the disk
    // read populated the schema.
    let unknown = find("unknown-field");
    assert_eq!(
        unknown.len(),
        1,
        "expected one unknown-field even with templates/ ignored, got: {:#?}",
        unknown
    );
    assert_eq!(
        unknown[0]["message"],
        "unknown frontmatter field 'bogus' for type 'ticket'"
    );

    let enum_bad = find("invalid-enum-value");
    assert_eq!(
        enum_bad.len(),
        1,
        "expected one invalid-enum-value even with templates/ ignored, got: {:#?}",
        enum_bad
    );
    assert_eq!(
        enum_bad[0]["message"],
        "frontmatter field 'kind' value 'banana' not one of: chore, feature, fix"
    );
}
