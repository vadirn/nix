//! `consult` subcommand integration tests: relevance gate, JSON/markdown envelopes,
//! oversized-pointer navigation, JSONL logging, and superseded/checkpoint scope.
//!
//! Hardening (Step 18d): the relevant query "retry backoff failure" deterministically
//! *selects* against the fixture corpus (see `test_consult_relevant_query_exits_0_with_content`),
//! and the nonsense query deterministically *abstains*. Tests that previously hedged with a
//! `code == 0 || code == 4` oracle now pin the single outcome the fixture guarantees, and
//! stdout previews in failure messages use char-boundary-safe truncation.

mod common;
use common::*;

use std::process::Command;

/// A query matching "Retry patterns.md" exits 0 and contains the document body.
#[test]
fn test_consult_relevant_query_exits_0_with_content() {
    let (stdout, code) = run_consult(&["retry backoff failure"]);
    assert_eq!(code, 0, "expected exit 0 for relevant query, stdout: {}", stdout);
    assert!(!stdout.is_empty(), "expected non-empty output for selected outcome");
    // Should contain the card's title or body excerpt
    assert!(
        stdout.contains("Retry") || stdout.contains("retry") || stdout.contains("backoff"),
        "expected retry content in output: {}",
        stdout
    );
}

/// A query that cannot possibly match any vault content exits 4 (abstain).
#[test]
fn test_consult_irrelevant_query_exits_4_with_near_misses() {
    // Use a nonsense string unlikely to appear in any vault document.
    let (stdout, code) = run_consult(&["xyzzy_zork_quux_frobnicator_abcdefgh123"]);
    assert_eq!(code, 4, "expected exit 4 (abstain) for irrelevant query, stdout: {}", stdout);
    assert!(!stdout.is_empty(), "abstain output should be non-empty (near_misses note)");
}

/// `--format json` emits a valid `selected` envelope for the relevant query.
/// The retry query pins the selected outcome, so this asserts deterministically
/// rather than branching on a `code == 0 || code == 4` oracle.
#[test]
fn test_consult_json_format_selected_is_valid() {
    let (stdout, code) = run_consult(&["retry backoff failure", "--format", "json"]);
    assert_eq!(
        code, 0,
        "relevant query must deterministically select; stdout: {}",
        truncate(&stdout, 200)
    );
    let v: serde_json::Value = serde_json::from_str(&stdout)
        .unwrap_or_else(|e| panic!("expected valid JSON ({e}), got: {}", truncate(&stdout, 200)));
    assert_eq!(v["status"].as_str(), Some("selected"), "wrong status field");
    assert!(v["docs"].is_array(), "missing docs array");
    assert!(v.get("total_tokens").is_some(), "missing total_tokens");
    assert!(v.get("query").is_some(), "missing query");
}

/// `--format json` emits valid JSON for an abstain outcome.
#[test]
fn test_consult_json_format_abstain_is_valid() {
    let (stdout, code) = run_consult(&["xyzzy_zork_quux_frobnicator_abcdefgh123", "--format", "json"]);
    assert_eq!(code, 4, "expected exit 4 for irrelevant query, stdout: {}", stdout);
    let v: serde_json::Value = serde_json::from_str(&stdout)
        .unwrap_or_else(|e| panic!("expected valid JSON abstain envelope ({e}), got: {}", truncate(&stdout, 200)));
    assert_eq!(v["status"].as_str(), Some("abstain"), "wrong status field");
    assert!(v["near_misses"].is_array(), "missing near_misses array in abstain envelope");
    assert!(v.get("reason").is_some(), "missing reason in abstain envelope");
}

/// With a per-doc cap that no document can satisfy, a relevant query still exits 0:
/// found-but-too-big is Selected with empty docs and the find surfaced as pointers.
#[test]
fn test_consult_oversized_candidates_exit_0_with_pointers() {
    // No CLI flag exists for the cap, so it rides in via a temp root config (the
    // JSONL log test pattern).  `--vault-root` still pins the corpus to the fixture
    // vault: without it the layer-1 walk-up from the test cwd finds the developer's
    // own `.vault.config.json` and queries the real vault.
    let tmp_home = tempfile::tempdir().unwrap();
    write_root_config(tmp_home.path(), serde_json::json!({ "per_doc_token_cap": 1 }));

    let output = Command::new(cargo_bin())
        .env("HOME", tmp_home.path())
        .args([
            "consult",
            "retry backoff failure",
            "--vault-root",
            fixture_dir().to_str().unwrap(),
            "--format",
            "json",
            "--no-log",
        ])
        .output()
        .expect("failed to run vault-query consult");
    let stdout = String::from_utf8(output.stdout).unwrap();
    let code = output.status.code().unwrap_or(-1);

    assert_eq!(
        code, 0,
        "found-but-too-big must exit 0 (selected with pointers), stdout: {}",
        stdout
    );
    let v: serde_json::Value = serde_json::from_str(&stdout)
        .unwrap_or_else(|e| panic!("expected valid JSON ({e}), got: {}", truncate(&stdout, 200)));
    assert_eq!(v["status"].as_str(), Some("selected"), "wrong status field");
    assert_eq!(
        v["docs"].as_array().map(|a| a.len()),
        Some(0),
        "no doc fits a 1-token cap; docs must be empty"
    );
    let pointers = v["pointers"].as_array().expect("missing pointers array");
    assert!(!pointers.is_empty(), "expected at least one pointer for the relevant doc");
    for p in pointers {
        assert!(p["path"].as_str().is_some(), "pointer missing path");
        assert!(p["tokens_est"].as_u64().unwrap_or(0) > 0, "pointer tokens_est must be > 0");
    }
}

/// The markdown overflow pointer is a navigate verb, not a full-file dump: an
/// oversized match emits `→ vault-query read "<path>"` so the agent drills into
/// a folded overview instead of pulling the whole document.
#[test]
fn test_consult_oversized_pointer_emits_read_verb() {
    let tmp_home = tempfile::tempdir().unwrap();
    write_root_config(tmp_home.path(), serde_json::json!({ "per_doc_token_cap": 1 }));

    let output = Command::new(cargo_bin())
        .env("HOME", tmp_home.path())
        .args([
            "consult",
            "retry backoff failure",
            "--vault-root",
            fixture_dir().to_str().unwrap(),
            "--format",
            "markdown",
            "--no-log",
        ])
        .output()
        .expect("failed to run vault-query consult");
    let stdout = String::from_utf8(output.stdout).unwrap();

    assert_eq!(output.status.code().unwrap_or(-1), 0, "stdout: {}", stdout);
    assert!(
        stdout.contains("→ vault-query read \""),
        "oversized pointer must navigate via `read`, got: {}",
        stdout
    );
    assert!(
        !stdout.contains("→ vault-query get \""),
        "the `get` full-file dump must no longer appear, got: {}",
        stdout
    );
    // The matching card (`20 cards/Retry patterns.md`) is heading-less, so its
    // matched terms attribute to the `(text)` region: the pointer lands the
    // agent on address `0`, not a bare overview.
    assert!(
        stdout.contains("Retry patterns.md\" 0\n"),
        "oversized pointer must carry the matched section's address, got: {}",
        stdout
    );
}

// ---------------------------------------------------------------------------
// JSONL logging tests (Backlog 6, Decision 8)
// ---------------------------------------------------------------------------

/// With `log_path` set, one invocation appends exactly one parseable JSON line
/// with the expected keys; the command exit code is unaffected.
#[test]
fn test_consult_log_path_appends_one_jsonl_line() {
    let tmp = tempfile::tempdir().unwrap();
    let log_file = tmp.path().join("consult-log.jsonl");

    // File must not exist before the invocation.
    assert!(!log_file.exists(), "log file should not exist before first run");

    let (_stdout, code) = run_consult_with_log("retry backoff failure", &log_file);

    // The retry query deterministically selects against the fixture corpus.
    assert_eq!(code, 0, "retry query must select (exit 0), got {}", code);

    // Exactly one line must have been appended.
    let content = std::fs::read_to_string(&log_file)
        .expect("log file should exist after invocation");
    let lines: Vec<&str> = content.lines().collect();
    assert_eq!(lines.len(), 1, "expected exactly one JSONL line, got {}", lines.len());

    // The line must parse as JSON and carry the required keys.
    let record: serde_json::Value = serde_json::from_str(lines[0])
        .expect("log line should be valid JSON");

    // Required top-level keys:
    for key in &[
        "timestamp_ms", "query", "mode", "format", "outcome",
        "num_returned", "num_selected", "total_tokens",
        "selected_paths", "near_miss_titles", "near_miss_scores",
    ] {
        assert!(record.get(key).is_some(), "missing key '{}' in log record", key);
    }

    // Diagnostic keys (may be null for empty corpora):
    for key in &["top_score", "median_score", "coverage", "max_top3_coverage", "elbow_ratio"] {
        assert!(record.get(key).is_some(), "missing diagnostic key '{}' in log record", key);
    }

    // mode is "deliberate" (no --ambient flag).
    assert_eq!(record["mode"].as_str(), Some("deliberate"));

    // outcome matches the pinned (selected) exit code.
    assert_eq!(
        record["outcome"].as_str(),
        Some("selected"),
        "outcome field mismatch"
    );
}

/// A second invocation appends a second line (not overwriting the first).
#[test]
fn test_consult_log_path_appends_not_overwrites() {
    let tmp = tempfile::tempdir().unwrap();
    let log_file = tmp.path().join("consult-log.jsonl");

    run_consult_with_log("retry backoff failure", &log_file);
    run_consult_with_log("retry backoff failure", &log_file);

    let content = std::fs::read_to_string(&log_file).unwrap();
    let lines: Vec<&str> = content.lines().filter(|l| !l.is_empty()).collect();
    assert_eq!(lines.len(), 2, "expected two JSONL lines after two runs, got {}", lines.len());

    // Both lines must be parseable.
    for (i, line) in lines.iter().enumerate() {
        serde_json::from_str::<serde_json::Value>(line)
            .unwrap_or_else(|e| panic!("line {} is not valid JSON: {}", i + 1, e));
    }
}

/// With `log_path = None` (default), no file is written and the command behaves normally.
#[test]
fn test_consult_no_log_path_no_file_written() {
    // Use the standard fixture-vault run_consult helper (no log_path in config).
    let tmp = tempfile::tempdir().unwrap();
    let would_be_log = tmp.path().join("should-not-exist.jsonl");

    // No --log-path flag; the default config has no log_path.
    let (stdout, code) = run_consult(&["retry backoff failure"]);

    // The retry query deterministically selects.
    assert_eq!(code, 0, "retry query must select (exit 0), got {}", code);
    assert!(!stdout.is_empty());

    // And no file appeared at our would-be location (trivially true; just guards the contract).
    assert!(!would_be_log.exists(), "log file should not be created when log_path is None");
}

// ---------------------------------------------------------------------------
// --no-log and --log-path flag tests (Backlog 26)
// ---------------------------------------------------------------------------

/// `--no-log` suppresses the JSONL record even when the config has a log_path set.
#[test]
fn test_consult_no_log_flag_suppresses_write() {
    let tmp = tempfile::tempdir().unwrap();
    let log_file = tmp.path().join("consult-log.jsonl");

    // Build a config with log_path set to an absolute path.
    let tmp_home = tempfile::tempdir().unwrap();
    write_root_config(
        tmp_home.path(),
        serde_json::json!({ "log_path": log_file.to_str().unwrap() }),
    );

    let output = Command::new(cargo_bin())
        .env("HOME", tmp_home.path())
        .args(["consult", "retry backoff failure", "--no-log"])
        .output()
        .expect("failed to run vault-query consult");

    let code = output.status.code().unwrap_or(-1);
    assert_eq!(code, 0, "retry query must select (exit 0), got {}", code);

    // The log file must NOT have been created despite config log_path being set.
    assert!(
        !log_file.exists(),
        "--no-log must suppress the log write even when config log_path is set"
    );
}

/// `--log-path <PATH>` writes the record to the override path, not the config path.
#[test]
fn test_consult_log_path_flag_overrides_config() {
    let tmp = tempfile::tempdir().unwrap();
    let config_log_file = tmp.path().join("config-log.jsonl");
    let override_log_file = tmp.path().join("override-log.jsonl");

    // Build a config with log_path pointing at config_log_file.
    let tmp_home = tempfile::tempdir().unwrap();
    write_root_config(
        tmp_home.path(),
        serde_json::json!({ "log_path": config_log_file.to_str().unwrap() }),
    );

    let output = Command::new(cargo_bin())
        .env("HOME", tmp_home.path())
        .args([
            "consult",
            "retry backoff failure",
            "--log-path",
            override_log_file.to_str().unwrap(),
        ])
        .output()
        .expect("failed to run vault-query consult");

    let code = output.status.code().unwrap_or(-1);
    assert_eq!(code, 0, "retry query must select (exit 0), got {}", code);

    // Record must appear at the override path.
    assert!(
        override_log_file.exists(),
        "--log-path record must be written to the override path"
    );
    let content = std::fs::read_to_string(&override_log_file).unwrap();
    let lines: Vec<&str> = content.lines().filter(|l| !l.is_empty()).collect();
    assert_eq!(lines.len(), 1, "expected exactly one JSONL line at override path");
    serde_json::from_str::<serde_json::Value>(lines[0])
        .expect("override log line must be valid JSON");

    // The config-path log must NOT have been touched.
    assert!(
        !config_log_file.exists(),
        "--log-path must not write to the config log_path"
    );
}

// ---------------------------------------------------------------------------
// --include-superseded / checkpoint scope tests
// ---------------------------------------------------------------------------

/// Superseded entries are excluded from consult scope by default.
/// "Superseded card.md" has `superseded: true` and body text containing the unique
/// nonsense token "xkqzflpbvmt" repeated many times. Without `--include-superseded`,
/// a query for that token must abstain (exit 4) — the entry is not indexed.
#[test]
fn test_consult_superseded_excluded_by_default() {
    let (stdout, code) = run_consult(&["xkqzflpbvmt", "--no-log"]);
    assert_eq!(
        code, 4,
        "consult must abstain (exit 4) when the only matching entry is superseded; \
         stdout: {}",
        stdout
    );
}

/// With `--include-superseded`, the superseded entry enters the consult scope.
/// "Superseded card.md" contains the unique token "xkqzflpbvmt" repeated 15 times;
/// no other fixture contains that token, so it scores clearly above median (single
/// result — vacuous elbow) and the gate passes.
#[test]
fn test_consult_superseded_included_with_flag() {
    let (stdout, code) = run_consult(&[
        "xkqzflpbvmt",
        "--include-superseded",
        "--no-log",
        "--types",
        "card",
    ]);
    assert_eq!(
        code, 0,
        "consult must select (exit 0) the superseded entry when --include-superseded is set; \
         stdout: {}",
        stdout
    );
    // The [superseded] label must appear in the markdown heading.
    assert!(
        stdout.contains("[superseded]"),
        "expected [superseded] label in rendered heading; stdout: {}",
        stdout
    );
}

/// Checkpoint entries (type: checkpoint) are excluded from consult scope by default.
/// The fixture at "41 projects/nix/checkpoint-001.md" has `type: checkpoint`.
/// A query for terms exclusive to that file must abstain when `--types card,checkpoint`
/// is passed but the checkpoint is still excluded by the superseded gate.
///
/// We verify exclusion via the API directly (unit-test style) rather than via CLI,
/// since the CLI fixture corpus has non-checkpoint cards that could satisfy the gate.
#[test]
fn test_consult_checkpoint_excluded_by_default() {
    use vault_query::commands::consult::{run_consult as run_consult_api, ConsultMode, ConsultOutcome};
    use vault_query::config::ConsultConfig;

    // Build a minimal VaultFile for a checkpoint with recognisable body text.
    let body_term = "checkpoint-consult-gate-test-term";
    let content = format!("---\ntype: checkpoint\ndone: true\n---\n\n{}\n", body_term);
    let checkpoint_file = vault_file("checkpoint-test")
        .path("/vault/checkpoint-test.md")
        .str_field("type", "checkpoint")
        .bool_field("done", true)
        .content(content)
        .build();

    let vault_root = std::path::PathBuf::from("/vault");
    // Pass an empty scope_types so that both "checkpoint" and "card" types are in scope —
    // the superseded gate (not the type filter) is what must exclude it.
    let scope_types: Vec<String> = vec![];
    // elbow_k = 1.0 isolates to superseded-gate behaviour.
    let config = ConsultConfig {
        elbow_k: 1.0,
        ..Default::default()
    };

    let (result, _diag) = run_consult_api(
        body_term,
        &[checkpoint_file],
        &vault_root,
        &scope_types,
        &config,
        ConsultMode::Deliberate,
        false, // include_superseded = false → checkpoint must be excluded
    )
    .unwrap();

    assert!(
        matches!(result, ConsultOutcome::Abstain { .. }),
        "checkpoint must be excluded from consult scope by default (include_superseded=false)"
    );
}
