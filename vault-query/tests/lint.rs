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
