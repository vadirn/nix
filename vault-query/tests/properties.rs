//! `properties` field-path read integration tests (Step 3).

mod common;
use common::*;

use std::process::Command;

#[test]
fn test_properties_nested_key() {
    let output = Command::new(cargo_bin())
        .args(["properties", read_fixture("properties.md").to_str().unwrap(), "nested.inner.leaf"])
        .output()
        .unwrap();
    assert!(output.status.success(), "expected exit 0");
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert_eq!(stdout.trim(), "deepvalue");
}

#[test]
fn test_properties_sequence_index() {
    let output = Command::new(cargo_bin())
        .args(["properties", read_fixture("properties.md").to_str().unwrap(), "references[1].target"])
        .output()
        .unwrap();
    assert!(output.status.success(), "expected exit 0");
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert_eq!(stdout.trim(), "beta");
}

#[test]
fn test_properties_missing_key_exits_1() {
    let output = Command::new(cargo_bin())
        .args(["properties", read_fixture("properties.md").to_str().unwrap(), "nope"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1), "expected exit 1 on missing key");
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("not found"), "stderr should explain the miss: {}", stderr);
}

#[test]
fn test_properties_out_of_range_index_exits_1() {
    let output = Command::new(cargo_bin())
        .args(["properties", read_fixture("properties.md").to_str().unwrap(), "references[9].target"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1), "expected exit 1 on OOB index");
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("out of range"), "stderr should explain the miss: {}", stderr);
}

#[test]
fn test_properties_json_value() {
    let output = Command::new(cargo_bin())
        .args(["properties", read_fixture("properties.md").to_str().unwrap(), "references[0]", "--format", "json"])
        .output()
        .unwrap();
    assert!(output.status.success(), "expected exit 0");
    let v: serde_json::Value =
        serde_json::from_str(&String::from_utf8(output.stdout).unwrap()).unwrap();
    assert_eq!(v["target"], "alpha");
    assert_eq!(v["note"], "first");
}

#[test]
fn test_properties_no_path_unchanged() {
    // The None path keeps the full-properties behavior.
    let output = Command::new(cargo_bin())
        .args(["properties", read_fixture("properties.md").to_str().unwrap()])
        .output()
        .unwrap();
    assert!(output.status.success(), "expected exit 0");
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.contains("slug"), "full properties should list field names: {}", stdout);
}
