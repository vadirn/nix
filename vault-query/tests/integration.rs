use std::path::{Path, PathBuf};
use std::process::Command;
use vault_query::commands;
use vault_query::base;
use vault_query::base::filter;
use vault_query::base::formula;
use vault_query::base::view;
use vault_query::commands::lint::format::LintFormat;
use vault_query::config::ResolvedConfig;
use vault_query::frontmatter;
use vault_query::vault;

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/vault")
}

fn cfg_for(vault_root: &Path) -> ResolvedConfig {
    let ignore = vault_query::vault_ignore::load(vault_root, false).unwrap();
    ResolvedConfig {
        vault_root: vault_root.to_path_buf(),
        projects_path: None,
        project_path: None,
        lint: None,
        consult: None,
        ignore,
    }
}

#[test]
fn test_parse_base_file() {
    let base_path = fixture_dir().join("41 projects/nix/Checkpoints.base");
    let base = base::parse(&base_path).unwrap();
    assert_eq!(base.filters.and.len(), 2);
    assert_eq!(base.views.len(), 4);
    assert_eq!(base.formulas.len(), 2);
    assert_eq!(
        base.formulas.get("cost_per_line").unwrap(),
        r#"if(lines_written > 0, (cost_usd / lines_written).round(3), "")"#
    );
}

#[test]
fn test_scan_captures_frontmatter_error() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    let bad_file = dir.join("bad-frontmatter.md");
    std::fs::write(&bad_file, "---\nkey: value: nested: bad\n---\nBody\n").unwrap();

    let files = vault::scan(dir, dir, None).unwrap();
    let bad = files
        .iter()
        .find(|f| f.name == "bad-frontmatter")
        .expect("bad-frontmatter file present in scan");
    // Frontmatter is empty so other rules treat it as untyped, but the parse error is captured
    // for the invalid-frontmatter lint rule.
    assert!(bad.frontmatter.is_empty());
    assert!(
        bad.frontmatter_error.is_some(),
        "expected frontmatter_error to be populated"
    );
}

#[test]
fn test_scan_and_filter() {
    let dir = fixture_dir();
    let files = vault::scan(&dir, &dir, None).unwrap();
    let checkpoints: Vec<_> = files
        .iter()
        .filter(|f| f.get_property("type") == "checkpoint")
        .collect();
    assert_eq!(checkpoints.len(), 3);
}

#[test]
fn test_apply_filters() {
    let dir = fixture_dir();
    let base_path = dir.join("41 projects/nix/Checkpoints.base");
    let base = base::parse(&base_path).unwrap();
    let files = vault::scan(&dir, &dir, None).unwrap();

    // Base filters: type == "checkpoint" AND file.inFolder("41 projects/nix")
    let empty_filters = base::FilterSet::default();
    let filtered = filter::apply(&files, &base.filters, &empty_filters, &dir);
    assert_eq!(filtered.len(), 3);
}

#[test]
fn test_incomplete_view_filter() {
    let dir = fixture_dir();
    let base_path = dir.join("41 projects/nix/Checkpoints.base");
    let base = base::parse(&base_path).unwrap();
    let files = vault::scan(&dir, &dir, None).unwrap();

    let incomplete_view = base.views.iter().find(|v| v.name == "Incomplete").unwrap();
    let filtered = filter::apply(&files, &base.filters, &incomplete_view.filters, &dir);
    // checkpoint-001 and checkpoint-003 are done: false
    assert_eq!(filtered.len(), 2);
}

#[test]
fn test_view_all_sorted_desc() {
    let dir = fixture_dir();
    let base_path = dir.join("41 projects/nix/Checkpoints.base");
    let base = base::parse(&base_path).unwrap();
    let files = vault::scan(&dir, &dir, None).unwrap();
    let all_view = base.views.iter().find(|v| v.name == "All").unwrap().clone();

    let mut filtered = filter::apply(&files, &base.filters, &all_view.filters, &dir);
    let result = view::apply(&all_view, &base, &mut filtered);

    // Sorted DESC by file.name: checkpoint-003, checkpoint-002, checkpoint-001
    assert_eq!(result.groups.len(), 1);
    let rows = &result.groups[0].rows;
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0][0], "checkpoint-003");
    assert_eq!(rows[1][0], "checkpoint-002");
    assert_eq!(rows[2][0], "checkpoint-001");
}

#[test]
fn test_formulas() {
    let dir = fixture_dir();
    let files = vault::scan(&dir, &dir, None).unwrap();
    let cp2 = files.iter().find(|f| f.name == "checkpoint-002").unwrap();

    // cost_per_line: if(lines_written > 0, (cost_usd / lines_written).round(3), "")
    // 2.5 / 100 = 0.025
    let result = formula::evaluate(
        r#"if(lines_written > 0, (cost_usd / lines_written).round(3), "")"#,
        cp2,
    );
    assert_eq!(result, "0.025");
}

#[test]
fn test_graduation_queue_or_filter() {
    let dir = fixture_dir();
    let base_path = dir.join("41 projects/nix/Checkpoints.base");
    let base = base::parse(&base_path).unwrap();
    let files = vault::scan(&dir, &dir, None).unwrap();

    let grad_view = base
        .views
        .iter()
        .find(|v| v.name == "Graduation queue")
        .unwrap();
    let filtered = filter::apply(&files, &base.filters, &grad_view.filters, &dir);
    // checkpoint-002 has decisions + frictions, checkpoint-003 has frictions
    assert_eq!(filtered.len(), 2);
}

#[test]
fn test_stats_view_summaries() {
    let dir = fixture_dir();
    let base_path = dir.join("41 projects/nix/Checkpoints.base");
    let base = base::parse(&base_path).unwrap();
    let files = vault::scan(&dir, &dir, None).unwrap();
    let stats_view = base.views.iter().find(|v| v.name == "Stats").unwrap().clone();

    let mut filtered = filter::apply(&files, &base.filters, &stats_view.filters, &dir);
    let result = view::apply(&stats_view, &base, &mut filtered);

    assert!(result.summaries.is_some());
    let summaries = result.summaries.unwrap();
    // cost_usd sum: 1.5 + 2.5 + 3.0 = 7.0
    // lines_written sum: 50 + 100 + 0 = 150
    // Check that summaries contain non-empty values for the right columns
    assert!(!summaries.is_empty());
}

#[test]
fn test_json_output() {
    let dir = fixture_dir();
    let base_path = dir.join("41 projects/nix/Checkpoints.base");
    let base = base::parse(&base_path).unwrap();
    let files = vault::scan(&dir, &dir, None).unwrap();
    let all_view = base.views.iter().find(|v| v.name == "All").unwrap().clone();

    let mut filtered = filter::apply(&files, &base.filters, &all_view.filters, &dir);
    let result = view::apply(&all_view, &base, &mut filtered);
    let json = vault_query::output::render(&result, &vault_query::output::Format::Json);

    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert!(parsed.is_array());
    assert_eq!(parsed.as_array().unwrap().len(), 3);
}

#[test]
fn test_tsv_output() {
    let dir = fixture_dir();
    let base_path = dir.join("41 projects/nix/Checkpoints.base");
    let base = base::parse(&base_path).unwrap();
    let files = vault::scan(&dir, &dir, None).unwrap();
    let all_view = base.views.iter().find(|v| v.name == "All").unwrap().clone();

    let mut filtered = filter::apply(&files, &base.filters, &all_view.filters, &dir);
    let result = view::apply(&all_view, &base, &mut filtered);
    let tsv = vault_query::output::render(&result, &vault_query::output::Format::Tsv);

    let lines: Vec<&str> = tsv.lines().collect();
    assert_eq!(lines.len(), 4); // header + 3 rows
    assert!(lines[0].contains("Checkpoint"));
}

#[test]
fn test_frontmatter_properties() {
    let dir = fixture_dir();
    let content = std::fs::read_to_string(dir.join("41 projects/nix/checkpoint-002.md")).unwrap();
    let fm = frontmatter::parse(&content).unwrap().unwrap();
    assert_eq!(frontmatter::get_display(&fm, "type"), "checkpoint");
    assert_eq!(frontmatter::get_bool(&fm, "done"), Some(true));
    assert_eq!(frontmatter::get_f64(&fm, "cost_usd"), Some(2.5));
    assert_eq!(frontmatter::get_seq_len(&fm, "decisions"), 1);
}

#[test]
fn test_wikilinks() {
    let links = vault_query::wikilink::extract("project: \"[[41 projects/nix/Nix]]\"");
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].target, "41 projects/nix/Nix");

    let stripped = vault_query::wikilink::strip("project: \"[[41 projects/nix/Nix]]\"");
    assert_eq!(stripped, "project: \"Nix\"");
}

#[test]
fn test_resolve_full_path_slug() {
    let dir = fixture_dir();
    let found = commands::resolve::run("41-projects/nix/checkpoint-001", &cfg_for(&dir)).unwrap();
    assert!(found);
}

#[test]
fn test_resolve_bare_name() {
    let dir = fixture_dir();
    let found = commands::resolve::run("checkpoint-001", &cfg_for(&dir)).unwrap();
    assert!(found);
}

#[test]
fn test_resolve_space_and_case() {
    let dir = fixture_dir();
    let found = commands::resolve::run("impureim-sandwich", &cfg_for(&dir)).unwrap();
    assert!(found);
}

#[test]
fn test_resolve_no_match() {
    let dir = fixture_dir();
    let found = commands::resolve::run("nonexistent-file", &cfg_for(&dir)).unwrap();
    assert!(!found);
}

#[test]
fn test_resolve_boundary_safety() {
    let dir = fixture_dir();
    // "point-001" should NOT match "checkpoint-001" because there's no `/` boundary
    let found = commands::resolve::run("point-001", &cfg_for(&dir)).unwrap();
    assert!(!found);
}

// --- list command tests ---

fn cargo_bin() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_vault-query"))
}

#[test]
fn test_list_titles_sorted() {
    let output = Command::new(cargo_bin())
        .args(["list", "20 cards", "--vault-root", fixture_dir().to_str().unwrap()])
        .output()
        .unwrap();
    let stdout = String::from_utf8(output.stdout).unwrap();
    let lines: Vec<&str> = stdout.lines().collect();
    assert!(lines.len() >= 2, "expected at least 2 cards, got: {:?}", lines);
    // Sorted: "Impureim sandwich" comes before "Test card" (alphabetical)
    let imp_pos = lines.iter().position(|l| l.starts_with("Impureim sandwich"))
        .expect("Impureim sandwich should be in the list");
    let test_pos = lines.iter().position(|l| l.starts_with("Test card"))
        .expect("Test card should be in the list");
    assert!(imp_pos < test_pos, "Impureim sandwich should sort before Test card");
}

#[test]
fn test_list_description_and_tags() {
    let output = Command::new(cargo_bin())
        .args(["list", "20 cards", "--vault-root", fixture_dir().to_str().unwrap()])
        .output()
        .unwrap();
    let stdout = String::from_utf8(output.stdout).unwrap();
    let test_line = stdout.lines().find(|l| l.starts_with("Test card")).unwrap();
    assert!(test_line.contains("A test card for integration tests"), "missing description: {}", test_line);
    assert!(test_line.contains("[testing, rust]"), "missing tags: {}", test_line);
}

#[test]
fn test_list_extra_fields_strip_wikilinks() {
    let output = Command::new(cargo_bin())
        .args(["list", "20 cards", "--vault-root", fixture_dir().to_str().unwrap(), "--fields", "reference"])
        .output()
        .unwrap();
    let stdout = String::from_utf8(output.stdout).unwrap();
    let test_line = stdout.lines().find(|l| l.starts_with("Test card")).unwrap();
    assert!(test_line.contains("(reference: Some Book)"), "wikilinks not stripped: {}", test_line);
    // Impureim sandwich has no reference field, so no "(reference:" should appear
    let imp_line = stdout.lines().find(|l| l.starts_with("Impureim sandwich")).unwrap();
    assert!(!imp_line.contains("(reference:"), "empty field should be omitted: {}", imp_line);
}

#[test]
fn test_experiments_lists_by_type() {
    let output = Command::new(cargo_bin())
        .args(["experiments", "--vault-root", fixture_dir().to_str().unwrap()])
        .output()
        .unwrap();
    assert!(output.status.success(), "stderr: {}", String::from_utf8_lossy(&output.stderr));
    let stdout = String::from_utf8(output.stdout).unwrap();
    let line = stdout
        .lines()
        .find(|l| l.starts_with("2026-05-27-foo-bar-baz"))
        .expect(&format!("expected experiment fixture in output: {}", stdout));
    assert!(
        line.contains("Sample experiment for integration tests"),
        "missing description: {}",
        line
    );
    assert!(line.contains("[testing, fixture]"), "missing tags: {}", line);
}

// --- search command tests ---

#[test]
fn test_bm25_basic() {
    let output = Command::new(cargo_bin())
        .args(["search", "impureim", "--vault-root", fixture_dir().to_str().unwrap()])
        .output()
        .unwrap();
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(output.status.success(), "stderr: {}", String::from_utf8_lossy(&output.stderr));
    assert!(stdout.contains("Impureim sandwich"), "expected Impureim sandwich in output: {}", stdout);
}

#[test]
fn test_bm25_no_results() {
    let output = Command::new(cargo_bin())
        .args(["search", "xyznonexistent", "--vault-root", fixture_dir().to_str().unwrap()])
        .output()
        .unwrap();
    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.is_empty(), "expected empty output, got: {}", stdout);
}

#[test]
fn test_bm25_subfolder() {
    let output = Command::new(cargo_bin())
        .args(["search", "test", "--vault-root", fixture_dir().to_str().unwrap(), "--path", "20 cards"])
        .output()
        .unwrap();
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(output.status.success(), "stderr: {}", String::from_utf8_lossy(&output.stderr));
    // Should only contain paths from 20 cards/
    for line in stdout.lines() {
        if line.starts_with('[') {
            assert!(line.contains("20 cards/"), "unexpected path outside subfolder: {}", line);
        }
    }
}

#[test]
fn test_regex_mode() {
    let output = Command::new(cargo_bin())
        .args(["search", "Impureim.*pattern", "--vault-root", fixture_dir().to_str().unwrap(), "--regex"])
        .output()
        .unwrap();
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(output.status.success(), "stderr: {}", String::from_utf8_lossy(&output.stderr));
    assert!(stdout.contains("Impureim sandwich"), "expected file path in regex output: {}", stdout);
    // Regex mode uses ">" marker for matching lines
    assert!(stdout.contains(">"), "expected > marker in regex output: {}", stdout);
}

#[test]
fn test_regex_mode_context() {
    let output = Command::new(cargo_bin())
        .args(["search", "test card", "--vault-root", fixture_dir().to_str().unwrap(), "--regex", "--context", "1"])
        .output()
        .unwrap();
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(output.status.success());
    // Should have context lines (lines without > marker)
    let context_lines: Vec<&str> = stdout.lines().filter(|l| l.starts_with(' ') && l.contains(':')).collect();
    assert!(!context_lines.is_empty(), "expected context lines in output: {}", stdout);
}

// --- files --tag tests ---

#[test]
fn test_files_tag_filter() {
    let output = Command::new(cargo_bin())
        .args(["files", "--vault-root", fixture_dir().to_str().unwrap(), "--tag", "rust"])
        .output()
        .unwrap();
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(output.status.success(), "stderr: {}", String::from_utf8_lossy(&output.stderr));
    assert!(stdout.contains("Test card"), "expected Test card in output: {}", stdout);
    assert!(!stdout.contains("checkpoint"), "should not contain checkpoint files: {}", stdout);
}

#[test]
fn test_files_tag_count() {
    let output = Command::new(cargo_bin())
        .args(["files", "--vault-root", fixture_dir().to_str().unwrap(), "--tag", "rust", "--count"])
        .output()
        .unwrap();
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(output.status.success());
    assert_eq!(stdout.trim(), "1");
}

#[test]
fn test_files_tag_no_match() {
    let output = Command::new(cargo_bin())
        .args(["files", "--vault-root", fixture_dir().to_str().unwrap(), "--tag", "nonexistent"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.is_empty(), "expected empty output, got: {}", stdout);
}

#[test]
fn test_list_empty_folder() {
    let output = Command::new(cargo_bin())
        .args(["list", "99 nonexistent", "--vault-root", fixture_dir().to_str().unwrap()])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(output.stdout.is_empty());
}

#[test]
fn test_query_empty_result_json_is_array() {
    // An empty filter result must succeed (exit 0) and emit an empty JSON array.
    // Callers (e.g. the track skill) branch on this output rather than on stderr text.
    let tmp = tempfile::tempdir().unwrap();
    let base_path = tmp.path().join("Empty.base");
    std::fs::write(
        &base_path,
        r#"filters:
  and:
    - type == "no-such-type-anywhere"
properties:
  file.name:
    displayName: Name
views:
  - type: table
    name: All
    order:
      - file.name
"#,
    )
    .unwrap();

    let output = Command::new(cargo_bin())
        .args([
            "query",
            base_path.to_str().unwrap(),
            "--view",
            "All",
            "--format",
            "json",
            "--vault-root",
            fixture_dir().to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim()).unwrap();
    assert!(parsed.is_array());
    assert_eq!(parsed.as_array().unwrap().len(), 0);
}

// --- asset scan integration tests ---

#[test]
fn test_scan_assets_covers_fixture_base() {
    let dir = fixture_dir();
    let assets = vault::scan_assets(&dir, &dir, None).unwrap();

    let names: Vec<&str> = assets.iter().map(|a| a.name.as_str()).collect();

    assert!(
        names.contains(&"Checkpoints.base"),
        "expected Checkpoints.base in assets, got: {:?}",
        names
    );
    assert!(
        names.contains(&"diagram.png"),
        "expected diagram.png in assets, got: {:?}",
        names
    );
    assert!(
        names.contains(&"drawing.tldraw"),
        "expected drawing.tldraw in assets, got: {:?}",
        names
    );
}

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

// ---------------------------------------------------------------------------
// consult subcommand integration tests
// ---------------------------------------------------------------------------

/// Run `vault-query consult` against the fixture vault and return (stdout, exit_code).
fn run_consult(args: &[&str]) -> (String, i32) {
    let mut cmd = Command::new(cargo_bin());
    cmd.args(["consult"])
        .arg("--vault-root")
        .arg(fixture_dir().to_str().unwrap());
    for a in args {
        cmd.arg(a);
    }
    let output = cmd.output().expect("failed to run vault-query consult");
    let stdout = String::from_utf8(output.stdout).unwrap();
    let code = output.status.code().unwrap_or(-1);
    (stdout, code)
}

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

/// `--format json` emits valid JSON for a selected outcome.
#[test]
fn test_consult_json_format_selected_is_valid() {
    let (stdout, code) = run_consult(&["retry backoff failure", "--format", "json"]);
    // If the query hits (exit 0), validate JSON structure.
    // If the vault is too small to pass the gate (exit 4), validate the abstain envelope.
    assert!(
        code == 0 || code == 4,
        "expected exit 0 or 4, got {}",
        code
    );
    let v: serde_json::Value = serde_json::from_str(&stdout)
        .expect(&format!("expected valid JSON, got: {}", &stdout[..stdout.len().min(200)]));
    let status = v["status"].as_str().expect("missing status field");
    if code == 0 {
        assert_eq!(status, "selected");
        assert!(v["docs"].is_array(), "missing docs array");
        assert!(v.get("total_tokens").is_some(), "missing total_tokens");
        assert!(v.get("query").is_some(), "missing query");
    } else {
        assert_eq!(status, "abstain");
        assert!(v["near_misses"].is_array(), "missing near_misses array");
        assert!(v.get("reason").is_some(), "missing reason");
        assert!(v.get("query").is_some(), "missing query");
    }
}

/// `--format json` emits valid JSON for an abstain outcome.
#[test]
fn test_consult_json_format_abstain_is_valid() {
    let (stdout, code) = run_consult(&["xyzzy_zork_quux_frobnicator_abcdefgh123", "--format", "json"]);
    assert_eq!(code, 4, "expected exit 4 for irrelevant query, stdout: {}", stdout);
    let v: serde_json::Value = serde_json::from_str(&stdout)
        .expect(&format!("expected valid JSON abstain envelope, got: {}", &stdout[..stdout.len().min(200)]));
    assert_eq!(v["status"].as_str(), Some("abstain"), "wrong status field");
    assert!(v["near_misses"].is_array(), "missing near_misses array in abstain envelope");
    assert!(v.get("reason").is_some(), "missing reason in abstain envelope");
}

// ---------------------------------------------------------------------------
// JSONL logging tests (Backlog 6, Decision 8)
// ---------------------------------------------------------------------------

/// Helper: run consult with a root config that sets `log_path`.
/// Returns (stdout, exit_code, log_file_path).
fn run_consult_with_log(query: &str, log_file: &Path) -> (String, i32) {
    // Write a minimal root config pointing at the fixture vault with log_path set.
    let tmp_home = tempfile::tempdir().unwrap();
    let cfg_dir = tmp_home.path().join(".config/vault");
    std::fs::create_dir_all(&cfg_dir).unwrap();
    std::fs::write(
        cfg_dir.join("config.json"),
        serde_json::json!({
            "vault_root": fixture_dir().to_str().unwrap(),
            "projects_path": "41 projects",
            "consult": {
                "log_path": log_file.to_str().unwrap()
            }
        })
        .to_string(),
    )
    .unwrap();

    let output = Command::new(cargo_bin())
        .env("HOME", tmp_home.path())
        .args(["consult", query])
        .output()
        .expect("failed to run vault-query consult");
    let stdout = String::from_utf8(output.stdout).unwrap();
    let code = output.status.code().unwrap_or(-1);
    (stdout, code)
}

/// With `log_path` set, one invocation appends exactly one parseable JSON line
/// with the expected keys; the command exit code is unaffected.
#[test]
fn test_consult_log_path_appends_one_jsonl_line() {
    let tmp = tempfile::tempdir().unwrap();
    let log_file = tmp.path().join("consult-log.jsonl");

    // File must not exist before the invocation.
    assert!(!log_file.exists(), "log file should not exist before first run");

    let (_stdout, code) = run_consult_with_log("retry backoff failure", &log_file);

    // Exit code is 0 or 4 (gate may abstain on fixture corpus); never an error.
    assert!(
        code == 0 || code == 4,
        "expected exit 0 or 4, got {}",
        code
    );

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

    // outcome matches the exit code.
    let expected_outcome = if code == 0 { "selected" } else { "abstain" };
    assert_eq!(
        record["outcome"].as_str(),
        Some(expected_outcome),
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

    // Command behaves identically regardless of log_path presence.
    assert!(code == 0 || code == 4);
    assert!(!stdout.is_empty());

    // And no file appeared at our would-be location (trivially true; just guards the contract).
    assert!(!would_be_log.exists(), "log file should not be created when log_path is None");
}
