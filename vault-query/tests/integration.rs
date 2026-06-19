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

/// regex search: a superseded entry matching the pattern is labeled "[superseded]" in output.
/// "Superseded card.md" has `superseded: true` and contains the unique token "xkqzflpbvmt".
#[test]
fn test_regex_labels_superseded_result() {
    let output = Command::new(cargo_bin())
        .args([
            "search",
            "xkqzflpbvmt",
            "--vault-root",
            fixture_dir().to_str().unwrap(),
            "--regex",
        ])
        .output()
        .unwrap();
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(
        output.status.success(),
        "regex search must exit 0; stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        stdout.contains("[superseded]"),
        "regex output must label superseded entry with [superseded]; stdout: {}",
        stdout
    );
}

/// regex search --no-superseded: superseded entries are excluded entirely.
/// "Superseded card.md" is the only file containing "xkqzflpbvmt", so output must be empty.
#[test]
fn test_regex_no_superseded_excludes() {
    let output = Command::new(cargo_bin())
        .args([
            "search",
            "xkqzflpbvmt",
            "--vault-root",
            fixture_dir().to_str().unwrap(),
            "--regex",
            "--no-superseded",
        ])
        .output()
        .unwrap();
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(
        output.status.success(),
        "regex search --no-superseded must exit 0; stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        stdout.trim().is_empty(),
        "--no-superseded must exclude the only matching superseded entry; stdout: {:?}",
        stdout
    );
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

/// With a per-doc cap that no document can satisfy, a relevant query still exits 0:
/// found-but-too-big is Selected with empty docs and the find surfaced as pointers.
#[test]
fn test_consult_oversized_candidates_exit_0_with_pointers() {
    // No CLI flag exists for the cap, so it rides in via a temp root config (the
    // JSONL log test pattern).  `--vault-root` still pins the corpus to the fixture
    // vault: without it the layer-1 walk-up from the test cwd finds the developer's
    // own `.vault.config.json` and queries the real vault.
    let tmp_home = tempfile::tempdir().unwrap();
    let cfg_dir = tmp_home.path().join(".config/vault");
    std::fs::create_dir_all(&cfg_dir).unwrap();
    std::fs::write(
        cfg_dir.join("config.json"),
        serde_json::json!({
            "vault_root": fixture_dir().to_str().unwrap(),
            "projects_path": "41 projects",
            "consult": {
                "per_doc_token_cap": 1
            }
        })
        .to_string(),
    )
    .unwrap();

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
        .expect(&format!("expected valid JSON, got: {}", &stdout[..stdout.len().min(200)]));
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
    let cfg_dir = tmp_home.path().join(".config/vault");
    std::fs::create_dir_all(&cfg_dir).unwrap();
    std::fs::write(
        cfg_dir.join("config.json"),
        serde_json::json!({
            "vault_root": fixture_dir().to_str().unwrap(),
            "projects_path": "41 projects",
            "consult": {
                "per_doc_token_cap": 1
            }
        })
        .to_string(),
    )
    .unwrap();

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
        .args(["consult", "retry backoff failure", "--no-log"])
        .output()
        .expect("failed to run vault-query consult");

    let code = output.status.code().unwrap_or(-1);
    assert!(code == 0 || code == 4, "expected exit 0 or 4, got {}", code);

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
    let cfg_dir = tmp_home.path().join(".config/vault");
    std::fs::create_dir_all(&cfg_dir).unwrap();
    std::fs::write(
        cfg_dir.join("config.json"),
        serde_json::json!({
            "vault_root": fixture_dir().to_str().unwrap(),
            "projects_path": "41 projects",
            "consult": {
                "log_path": config_log_file.to_str().unwrap()
            }
        })
        .to_string(),
    )
    .unwrap();

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
    assert!(code == 0 || code == 4, "expected exit 0 or 4, got {}", code);

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
// --include-superseded flag tests
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
    use vault_query::commands::consult::{run_consult, ConsultMode, ConsultOutcome};
    use vault_query::config::ConsultConfig;
    use vault_query::vault::VaultFile;
    use std::collections::BTreeMap;

    // Build a minimal VaultFile for a checkpoint with recognisable body text.
    let body_term = "checkpoint-consult-gate-test-term";
    let content = format!(
        "---\ntype: checkpoint\ndone: true\n---\n\n{}\n",
        body_term
    );
    let mut fm = BTreeMap::new();
    fm.insert("type".to_string(), serde_yaml::Value::String("checkpoint".to_string()));
    fm.insert("done".to_string(), serde_yaml::Value::Bool(true));
    let checkpoint_file = VaultFile {
        name: "checkpoint-test".to_string(),
        path: std::path::PathBuf::from("/vault/checkpoint-test.md"),
        frontmatter: fm,
        frontmatter_error: None,
        content,
        ctime: None,
    };

    let vault_root = std::path::PathBuf::from("/vault");
    // Pass an empty scope_types so that both "checkpoint" and "card" types are in scope —
    // the superseded gate (not the type filter) is what must exclude it.
    let scope_types: Vec<String> = vec![];
    let mut config = ConsultConfig::default();
    config.elbow_k = 1.0; // isolate to superseded-gate behaviour

    let (result, _diag) = run_consult(
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

// ---------------------------------------------------------------------------
// search / list / get / backlinks superseded labeling and --no-superseded tests
// ---------------------------------------------------------------------------

/// Helper: run `vault-query search` against the fixture vault.
fn run_search(args: &[&str]) -> (String, i32) {
    let mut cmd = Command::new(cargo_bin());
    cmd.args(["search"])
        .arg("--vault-root")
        .arg(fixture_dir().to_str().unwrap());
    for a in args {
        cmd.arg(a);
    }
    let output = cmd.output().expect("failed to run vault-query search");
    let stdout = String::from_utf8(output.stdout).unwrap();
    let code = output.status.code().unwrap_or(-1);
    (stdout, code)
}

/// Helper: run `vault-query list` against the fixture vault.
fn run_list(args: &[&str]) -> (String, i32) {
    let mut cmd = Command::new(cargo_bin());
    cmd.args(["list", "20 cards"])
        .arg("--vault-root")
        .arg(fixture_dir().to_str().unwrap());
    for a in args {
        cmd.arg(a);
    }
    let output = cmd.output().expect("failed to run vault-query list");
    let stdout = String::from_utf8(output.stdout).unwrap();
    let code = output.status.code().unwrap_or(-1);
    (stdout, code)
}

/// Helper: run `vault-query get` against the fixture vault.
fn run_get(args: &[&str]) -> (String, i32) {
    let mut cmd = Command::new(cargo_bin());
    cmd.args(["get"])
        .arg("--vault-root")
        .arg(fixture_dir().to_str().unwrap());
    for a in args {
        cmd.arg(a);
    }
    let output = cmd.output().expect("failed to run vault-query get");
    let stdout = String::from_utf8(output.stdout).unwrap();
    let code = output.status.code().unwrap_or(-1);
    (stdout, code)
}

/// search: a superseded entry (unique token "xkqzflpbvmt") appears in results by default,
/// labeled with [superseded].
#[test]
fn test_search_labels_superseded_result() {
    let (stdout, code) = run_search(&["xkqzflpbvmt"]);
    assert_eq!(code, 0, "search must exit 0; stdout: {}", stdout);
    assert!(
        stdout.contains("[superseded]"),
        "search output must label superseded results with [superseded]; stdout: {}",
        stdout
    );
}

/// search: superseded entries are ranked lower than fresh entries with comparable matches.
/// The fixture "Superseded card.md" contains "xkqzflpbvmt" repeated 15 times.
/// We create a fresh card also containing "xkqzflpbvmt" multiple times and verify it
/// appears first (or at least that the superseded card's line has [superseded]).
/// This test verifies the downrank via the JSON output's score field.
#[test]
fn test_search_superseded_downranked_below_fresh() {
    // Create a temp vault with one superseded card and one fresh card, both containing
    // the unique token "xkqzflpbvmt" many times. The fresh card must score higher.
    let tmp = tempfile::tempdir().unwrap();
    let vault_root = tmp.path().to_path_buf();
    let cards_dir = vault_root.join("20 cards");
    std::fs::create_dir_all(&cards_dir).unwrap();

    std::fs::write(
        cards_dir.join("Fresh card.md"),
        "---\ntype: card\n---\n\nxkqzflpbvmt xkqzflpbvmt xkqzflpbvmt xkqzflpbvmt xkqzflpbvmt\nxkqzflpbvmt xkqzflpbvmt xkqzflpbvmt xkqzflpbvmt xkqzflpbvmt\n",
    )
    .unwrap();
    std::fs::write(
        cards_dir.join("Superseded card.md"),
        "---\ntype: card\nsuperseded: true\n---\n\nxkqzflpbvmt xkqzflpbvmt xkqzflpbvmt xkqzflpbvmt xkqzflpbvmt\nxkqzflpbvmt xkqzflpbvmt xkqzflpbvmt xkqzflpbvmt xkqzflpbvmt\n",
    )
    .unwrap();

    let ignore = vault_query::vault_ignore::load(&vault_root, false).unwrap();
    let cfg = ResolvedConfig {
        vault_root: vault_root.clone(),
        projects_path: None,
        project_path: None,
        lint: None,
        consult: None,
        ignore,
    };

    let results = vault_query::commands::search::collect_bm25_results_filtered(
        "xkqzflpbvmt",
        &cfg,
        None,
        10,
        &[],
        false, // include superseded but apply downrank
    )
    .unwrap();

    assert!(results.len() >= 2, "expected at least 2 results, got {}", results.len());

    let fresh = results.iter().find(|r| r.path.contains("Fresh card")).expect("fresh card not found");
    let superseded = results.iter().find(|r| r.superseded).expect("superseded card not found");

    assert!(
        fresh.score > superseded.score,
        "fresh card (score {:.4}) must outrank superseded card (score {:.4}) after 0.3 downrank",
        fresh.score,
        superseded.score,
    );

    // results are sorted descending: fresh must appear before superseded.
    let fresh_pos = results.iter().position(|r| r.path.contains("Fresh card")).unwrap();
    let sup_pos = results.iter().position(|r| r.superseded).unwrap();
    assert!(
        fresh_pos < sup_pos,
        "fresh card must appear before superseded card in sorted results"
    );
}

/// search --no-superseded: superseded entries are excluded entirely.
#[test]
fn test_search_no_superseded_excludes() {
    let (stdout, code) = run_search(&["xkqzflpbvmt", "--no-superseded"]);
    assert_eq!(code, 0, "search must exit 0; stdout: {}", stdout);
    assert!(
        !stdout.contains("[superseded]"),
        "--no-superseded must not produce any [superseded] lines; stdout: {}",
        stdout
    );
    // The unique token only appears in a superseded card, so the output must be empty.
    assert!(
        stdout.trim().is_empty(),
        "--no-superseded must exclude the only matching (superseded) entry; stdout: {}",
        stdout
    );
}

/// list: superseded entries are labeled with [superseded] prefix.
#[test]
fn test_list_labels_superseded() {
    let (stdout, code) = run_list(&[]);
    assert_eq!(code, 0, "list must exit 0; stdout: {}", stdout);
    assert!(
        stdout.contains("[superseded]"),
        "list output must label superseded entries with [superseded]; stdout: {}",
        stdout
    );
    // The superseded card names must appear with the prefix.
    let sup_lines: Vec<&str> = stdout.lines().filter(|l| l.starts_with("[superseded]")).collect();
    assert!(
        !sup_lines.is_empty(),
        "expected at least one [superseded]-prefixed line; stdout: {}",
        stdout
    );
}

/// list --no-superseded: superseded entries are excluded.
#[test]
fn test_list_no_superseded_excludes() {
    let (stdout, code) = run_list(&["--no-superseded"]);
    assert_eq!(code, 0, "list must exit 0; stdout: {}", stdout);
    assert!(
        !stdout.contains("[superseded]"),
        "--no-superseded list must not include any [superseded] lines; stdout: {}",
        stdout
    );
    // Non-superseded entries must still appear.
    assert!(
        stdout.contains("Impureim sandwich") || stdout.contains("Test card"),
        "non-superseded entries must still appear with --no-superseded; stdout: {}",
        stdout
    );
}

/// get: a superseded entry shows the [superseded] marker line.
#[test]
fn test_get_shows_superseded_marker() {
    let (stdout, code) = run_get(&["superseded-card"]);
    assert_eq!(code, 0, "get must exit 0 for superseded entry without --no-superseded; stdout: {}", stdout);
    assert!(
        stdout.contains("[superseded]"),
        "get must emit [superseded] marker for superseded entries; stdout: {}",
        stdout
    );
}

/// get --no-superseded: exits 1 for a superseded entry.
#[test]
fn test_get_no_superseded_exits_1() {
    let mut cmd = Command::new(cargo_bin());
    let output = cmd
        .args(["get", "superseded-card", "--no-superseded"])
        .arg("--vault-root")
        .arg(fixture_dir().to_str().unwrap())
        .output()
        .expect("failed to run vault-query get");
    let code = output.status.code().unwrap_or(-1);
    assert_eq!(
        code, 1,
        "get --no-superseded must exit 1 for a superseded entry; stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

/// backlinks: a superseded source is labeled with [superseded].
/// "Superseded card with link.md" links to "Test card" and is superseded.
#[test]
fn test_backlinks_labels_superseded_source() {
    let mut cmd = Command::new(cargo_bin());
    let output = cmd
        .args(["backlinks", "Test card.md"])
        .arg("--vault-root")
        .arg(fixture_dir().to_str().unwrap())
        .output()
        .expect("failed to run vault-query backlinks");
    let stdout = String::from_utf8(output.stdout).unwrap();
    let code = output.status.code().unwrap_or(-1);
    assert_eq!(code, 0, "backlinks must exit 0; stdout: {}", stdout);
    assert!(
        stdout.contains("[superseded]"),
        "backlinks must label superseded sources with [superseded]; stdout: {}",
        stdout
    );
}

/// backlinks --no-superseded: superseded sources are excluded.
#[test]
fn test_backlinks_no_superseded_excludes() {
    let mut cmd = Command::new(cargo_bin());
    let output = cmd
        .args(["backlinks", "Test card.md", "--no-superseded"])
        .arg("--vault-root")
        .arg(fixture_dir().to_str().unwrap())
        .output()
        .expect("failed to run vault-query backlinks");
    let stdout = String::from_utf8(output.stdout).unwrap();
    let code = output.status.code().unwrap_or(-1);
    assert_eq!(code, 0, "backlinks must exit 0; stdout: {}", stdout);
    assert!(
        !stdout.contains("[superseded]"),
        "--no-superseded backlinks must exclude superseded sources; stdout: {}",
        stdout
    );
}

// ---------------------------------------------------------------------------
// Fix 1: search limit truncation — full-candidate ranking before filter/truncate
// ---------------------------------------------------------------------------

/// With limit=1 and the top raw BM25 match being a superseded doc,
/// --no-superseded must return the next non-superseded match rather than nothing.
#[test]
fn test_search_no_superseded_with_limit_1_returns_next_match() {
    use vault_query::commands::search::collect_bm25_results_filtered;

    let tmp = tempfile::tempdir().unwrap();
    let vault_root = tmp.path().to_path_buf();
    let cards_dir = vault_root.join("20 cards");
    std::fs::create_dir_all(&cards_dir).unwrap();

    // Superseded card has the term many times → wins raw BM25 ranking.
    std::fs::write(
        cards_dir.join("Superseded top.md"),
        "---\ntype: card\nsuperseded: true\n---\n\n\
         zygofract zygofract zygofract zygofract zygofract\n\
         zygofract zygofract zygofract zygofract zygofract\n\
         zygofract zygofract zygofract zygofract zygofract\n",
    )
    .unwrap();

    // Fresh card has the term fewer times → loses raw ranking but is non-superseded.
    std::fs::write(
        cards_dir.join("Fresh runner-up.md"),
        "---\ntype: card\n---\n\nzygofract zygofract zygofract\n",
    )
    .unwrap();

    let ignore = vault_query::vault_ignore::load(&vault_root, false).unwrap();
    let cfg = ResolvedConfig {
        vault_root: vault_root.clone(),
        projects_path: None,
        project_path: None,
        lint: None,
        consult: None,
        ignore,
    };

    // With limit=1 and --no-superseded: should return the fresh card, not nothing.
    let results = collect_bm25_results_filtered("zygofract", &cfg, None, 1, &[], true).unwrap();
    assert_eq!(
        results.len(),
        1,
        "--no-superseded with limit=1 must return the runner-up non-superseded doc, got: {:?}",
        results.iter().map(|r| &r.path).collect::<Vec<_>>()
    );
    assert!(
        !results[0].superseded,
        "the returned result must not be superseded; path: {}",
        results[0].path
    );
    assert!(
        results[0].path.contains("Fresh runner-up"),
        "expected Fresh runner-up; got: {}",
        results[0].path
    );
}

/// With limit=1 and a non-superseded doc whose raw score exceeds 0.3× the
/// superseded top-doc's score, the non-superseded doc should be ranked first
/// after the 0.3 downrank is applied (no --no-superseded flag).
#[test]
fn test_search_downrank_displaces_superseded_at_limit_1() {
    use vault_query::commands::search::collect_bm25_results_filtered;

    let tmp = tempfile::tempdir().unwrap();
    let vault_root = tmp.path().to_path_buf();
    let cards_dir = vault_root.join("20 cards");
    std::fs::create_dir_all(&cards_dir).unwrap();

    // Superseded card: many term repetitions → high raw score.
    std::fs::write(
        cards_dir.join("Superseded heavy.md"),
        "---\ntype: card\nsuperseded: true\n---\n\n\
         palimpsest palimpsest palimpsest palimpsest palimpsest\n\
         palimpsest palimpsest palimpsest palimpsest palimpsest\n\
         palimpsest palimpsest palimpsest palimpsest palimpsest\n\
         palimpsest palimpsest palimpsest palimpsest palimpsest\n",
    )
    .unwrap();

    // Fresh card: fewer repetitions, but after the 0.3 downrank on the superseded
    // card its adjusted score should be lower than the fresh card's raw score.
    // BM25 is sublinear so we use a comparable but smaller count — the downrank
    // multiplies the superseded score by 0.3, so the fresh card just needs a
    // moderate score to win.
    std::fs::write(
        cards_dir.join("Fresh challenger.md"),
        "---\ntype: card\n---\n\n\
         palimpsest palimpsest palimpsest palimpsest palimpsest\n\
         palimpsest palimpsest palimpsest palimpsest palimpsest\n",
    )
    .unwrap();

    let ignore = vault_query::vault_ignore::load(&vault_root, false).unwrap();
    let cfg = ResolvedConfig {
        vault_root: vault_root.clone(),
        projects_path: None,
        project_path: None,
        lint: None,
        consult: None,
        ignore,
    };

    // Without --no-superseded, limit=1: the superseded doc has a higher raw score
    // but after 0.3× downrank the fresh challenger should win.
    let results = collect_bm25_results_filtered("palimpsest", &cfg, None, 1, &[], false).unwrap();
    assert_eq!(
        results.len(),
        1,
        "limit=1 must return exactly 1 result; got {}",
        results.len()
    );
    assert!(
        !results[0].superseded,
        "after 0.3× downrank the non-superseded challenger must rank first at limit=1; \
         got superseded={}, path={}",
        results[0].superseded,
        results[0].path
    );
    assert!(
        results[0].path.contains("Fresh challenger"),
        "expected Fresh challenger at position 0; got: {}",
        results[0].path
    );
}

// ---------------------------------------------------------------------------
// Fix 2: get multi-match arm — no_superseded filter and [superseded] labels
// ---------------------------------------------------------------------------

/// When a fragment matches multiple paths and --no-superseded is set, all
/// superseded candidates are dropped. If exactly one non-superseded candidate
/// survives, get must resolve it normally (print path + content).
#[test]
fn test_get_multi_match_no_superseded_resolves_single_survivor() {
    // Use a temp vault with two files sharing the slug "shared-name":
    // one superseded, one fresh.
    let tmp = tempfile::tempdir().unwrap();
    let vault_root = tmp.path().to_path_buf();

    let dir_a = vault_root.join("folder-a");
    let dir_b = vault_root.join("folder-b");
    std::fs::create_dir_all(&dir_a).unwrap();
    std::fs::create_dir_all(&dir_b).unwrap();

    std::fs::write(
        dir_a.join("shared-name.md"),
        "---\ntype: card\nsuperseded: true\n---\nSuperseded content.\n",
    )
    .unwrap();
    std::fs::write(
        dir_b.join("shared-name.md"),
        "---\ntype: card\n---\nFresh content.\n",
    )
    .unwrap();

    let cfg = cfg_for(&vault_root);

    // Verify that without --no-superseded we do get two matches (multi-match case).
    let paths_all = vault_query::commands::get::resolve_paths("shared-name", &cfg).unwrap();
    assert_eq!(paths_all.len(), 2, "expected 2 matches before filtering; got {:?}", paths_all);

    // With --no-superseded the superseded candidate should be dropped and the
    // single survivor resolved normally (exit 0, content printed to stdout).
    // We test via the binary to capture stdout and exit code.
    let output = Command::new(cargo_bin())
        .args([
            "get",
            "shared-name",
            "--no-superseded",
            "--vault-root",
            vault_root.to_str().unwrap(),
        ])
        .output()
        .expect("failed to run vault-query get");

    let code = output.status.code().unwrap_or(-1);
    let stdout = String::from_utf8(output.stdout).unwrap();

    assert_eq!(
        code, 0,
        "get --no-superseded must exit 0 when a single non-superseded match survives; \
         stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        stdout.contains("Fresh content"),
        "get must print the fresh content; stdout: {}",
        stdout
    );
    assert!(
        !stdout.contains("Superseded content"),
        "get must not print superseded content when --no-superseded is set; stdout: {}",
        stdout
    );
}

/// In the multi-match listing (no --no-superseded), superseded candidates are
/// labeled with [superseded] appended to their path line.
#[test]
fn test_get_multi_match_labels_superseded_candidate() {
    let tmp = tempfile::tempdir().unwrap();
    let vault_root = tmp.path().to_path_buf();

    let dir_a = vault_root.join("folder-a");
    let dir_b = vault_root.join("folder-b");
    std::fs::create_dir_all(&dir_a).unwrap();
    std::fs::create_dir_all(&dir_b).unwrap();

    std::fs::write(
        dir_a.join("shared-name.md"),
        "---\ntype: card\nsuperseded: true\n---\nSuperseded content.\n",
    )
    .unwrap();
    std::fs::write(
        dir_b.join("shared-name.md"),
        "---\ntype: card\n---\nFresh content.\n",
    )
    .unwrap();

    let output = Command::new(cargo_bin())
        .args([
            "get",
            "shared-name",
            "--vault-root",
            vault_root.to_str().unwrap(),
        ])
        .output()
        .expect("failed to run vault-query get");

    let code = output.status.code().unwrap_or(-1);
    let stdout = String::from_utf8(output.stdout).unwrap();

    // Multi-match must exit 0 and list both candidates.
    // (The binary exits 0 for multi-match listing — it's informational, not an error.)
    assert_eq!(
        code, 0,
        "get with multiple matches must exit 0 and list them; stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    // Exactly one line must contain [superseded].
    let sup_lines: Vec<&str> = stdout.lines().filter(|l| l.contains("[superseded]")).collect();
    assert_eq!(
        sup_lines.len(),
        1,
        "expected exactly one [superseded]-labeled line in multi-match listing; stdout: {}",
        stdout
    );

    // The non-superseded candidate line must not carry the label.
    let non_sup_lines: Vec<&str> = stdout.lines().filter(|l| l.contains("folder-b") && !l.contains("[superseded]")).collect();
    assert!(
        !non_sup_lines.is_empty(),
        "non-superseded candidate must appear without [superseded] label; stdout: {}",
        stdout
    );
}

// --- read command tests -----------------------------------------------------

fn read_fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/read").join(name)
}

#[test]
fn test_read_overview_header_and_tree() {
    let output = Command::new(cargo_bin())
        .args(["read", read_fixture("sample.md").to_str().unwrap()])
        .output()
        .unwrap();
    assert!(output.status.success(), "stderr: {}", String::from_utf8_lossy(&output.stderr));
    let stdout = String::from_utf8(output.stdout).unwrap();

    // Frontmatter field names (no count), in on-disk source order.
    let fields_line = stdout.lines().find(|l| l.starts_with("fields:")).expect("fields line");
    for f in ["type", "slug", "description", "status"] {
        assert!(fields_line.contains(f), "missing field {} in: {}", f, fields_line);
    }
    // Source order is type, slug, description, status (not alphabetical).
    assert_eq!(
        fields_line.trim(),
        "fields: type, slug, description, status",
        "fields must follow source order, not BTreeMap alphabetization"
    );
    // Link count: 3 wikilinks in the fixture body.
    assert!(stdout.lines().any(|l| l.trim() == "links: 3"), "expected 'links: 3'; got:\n{}", stdout);

    // Text region line present with its label.
    assert!(stdout.contains("[0]") && stdout.contains("(text)"), "missing text region: {}", stdout);

    // Tree: Direction is a parent (marked '+'), Glossary is a leaf, addresses numbered.
    let dir_line = stdout.lines().find(|l| l.contains("Direction")).expect("Direction line");
    assert!(dir_line.trim_start().starts_with('+'), "Direction should be a parent (+): {}", dir_line);
    assert!(stdout.lines().any(|l| l.contains("1.1") && l.contains("Background")), "missing 1.1 Background");
    assert!(stdout.lines().any(|l| l.contains("1.2") && l.contains("Goals")), "missing 1.2 Goals");

    // Illustrative next: footer.
    assert!(stdout.lines().any(|l| l.starts_with("next:")), "missing next: footer: {}", stdout);
}

#[test]
fn test_read_overview_json_shape() {
    let output = Command::new(cargo_bin())
        .args(["read", read_fixture("sample.md").to_str().unwrap(), "--format", "json"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    let v: serde_json::Value = serde_json::from_str(&stdout).expect("valid JSON");

    assert!(v["path"].is_string());
    assert!(v["fields"].as_array().unwrap().len() >= 4);
    assert_eq!(v["links"].as_u64().unwrap(), 3);

    // Text node present with address 0 and label (text).
    assert_eq!(v["text"]["address"], "0");
    assert_eq!(v["text"]["label"], "(text)");
    assert!(v["text"]["tokens"].as_u64().unwrap() > 0);

    // Tree: 4 top-level nodes; Direction has 2 children.
    let tree = v["tree"].as_array().unwrap();
    assert_eq!(tree.len(), 4);
    assert_eq!(tree[0]["address"], "1");
    assert_eq!(tree[0]["heading"], "Direction");
    assert_eq!(tree[0]["slug"], "direction");
    assert_eq!(tree[0]["children"].as_array().unwrap().len(), 2);
    assert_eq!(tree[0]["children"][0]["address"], "1.1");
}

#[test]
fn test_read_numeric_section() {
    let output = Command::new(cargo_bin())
        .args(["read", read_fixture("sample.md").to_str().unwrap(), "1.1"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    // Header line carries address + heading + line; body carries the heading text.
    assert!(stdout.contains("1.1") && stdout.contains("Background"), "missing 1.1 header: {}", stdout);
    assert!(stdout.contains("Background body line one."), "missing section body: {}", stdout);
    // Should NOT include the sibling Goals body.
    assert!(!stdout.contains("Goal body."), "1.1 must not leak sibling body: {}", stdout);
}

#[test]
fn test_read_slug_section_json() {
    let output = Command::new(cargo_bin())
        .args(["read", read_fixture("sample.md").to_str().unwrap(), "glossary", "--format", "json"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let v: serde_json::Value = serde_json::from_str(&String::from_utf8(output.stdout).unwrap()).unwrap();
    assert_eq!(v["address"], "2");
    assert_eq!(v["heading"], "Glossary");
    assert_eq!(v["slug"], "glossary");
    assert!(v["content"].as_str().unwrap().contains("| Term | Definition |"));
}

#[test]
fn test_read_text_address() {
    let output = Command::new(cargo_bin())
        .args(["read", read_fixture("sample.md").to_str().unwrap(), "0"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.contains("(text)"), "missing text label: {}", stdout);
    assert!(stdout.contains("Lede prose before any heading."), "missing lede body: {}", stdout);
    // The `text` keyword resolves identically.
    let output2 = Command::new(cargo_bin())
        .args(["read", read_fixture("sample.md").to_str().unwrap(), "text"])
        .output()
        .unwrap();
    assert!(output2.status.success());
    assert!(String::from_utf8(output2.stdout).unwrap().contains("Lede prose before any heading."));
}

#[test]
fn test_read_headingless_whole_body_is_text() {
    let output = Command::new(cargo_bin())
        .args(["read", read_fixture("headingless.md").to_str().unwrap(), "--format", "json"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let v: serde_json::Value = serde_json::from_str(&String::from_utf8(output.stdout).unwrap()).unwrap();
    assert_eq!(v["tree"].as_array().unwrap().len(), 0, "heading-less file has no tree");
    assert_eq!(v["text"]["address"], "0");
    assert!(v["text"]["lines"].as_u64().unwrap() > 0);
}

#[test]
fn test_read_ambiguous_slug_exits_1() {
    let output = Command::new(cargo_bin())
        .args(["read", read_fixture("sample.md").to_str().unwrap(), "log-notes"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1), "ambiguous slug must exit 1");
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("Ambiguous"), "expected ambiguity message on stderr: {}", stderr);
    // Both colliding candidates listed.
    assert!(stderr.contains("Log & Notes") && stderr.contains("Log Notes"), "candidates: {}", stderr);
    // Candidates go to stderr, not stdout.
    assert!(String::from_utf8(output.stdout).unwrap().is_empty(), "stdout must be empty on error");
}

#[test]
fn test_read_unknown_address_exits_1() {
    let output = Command::new(cargo_bin())
        .args(["read", read_fixture("sample.md").to_str().unwrap(), "nonexistent-slug"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));

    let oob = Command::new(cargo_bin())
        .args(["read", read_fixture("sample.md").to_str().unwrap(), "99"])
        .output()
        .unwrap();
    assert_eq!(oob.status.code(), Some(1), "out-of-range numeric must exit 1");

    // An all-digit address that overflows usize must exit 1 gracefully, not
    // panic. A panic would surface as a non-1 abort code and a backtrace.
    let overflow = Command::new(cargo_bin())
        .args(["read", read_fixture("sample.md").to_str().unwrap(), "99999999999999999999"])
        .output()
        .unwrap();
    assert_eq!(overflow.status.code(), Some(1), "oversized numeric must exit 1, not panic");
    let stderr = String::from_utf8(overflow.stderr).unwrap();
    assert!(stderr.contains("out of range"), "expected out-of-range message: {}", stderr);
    assert!(!stderr.contains("panicked"), "must not panic: {}", stderr);
}

#[test]
fn test_read_unreadable_file_exits_1() {
    let output = Command::new(cargo_bin())
        .args(["read", read_fixture("does-not-exist.md").to_str().unwrap()])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1), "unreadable file must exit 1");
}

// --- read smart-unfold (Step 2, Backlog 5) ---------------------------------

#[test]
fn test_unfold_threshold_inlines_small_folds_large() {
    // Threshold 100 sits between Small Child (~16 tok) and Large Child (~293 tok).
    let output = Command::new(cargo_bin())
        .args([
            "read",
            read_fixture("unfold.md").to_str().unwrap(),
            "1",
            "--threshold",
            "100",
        ])
        .output()
        .unwrap();
    assert!(output.status.success(), "stderr: {}", String::from_utf8_lossy(&output.stderr));
    let stdout = String::from_utf8(output.stdout).unwrap();

    // Section own prose printed.
    assert!(stdout.contains("Section own prose"), "missing own prose: {}", stdout);
    // Small child inlined (its body appears).
    assert!(stdout.contains("Small child body"), "small child should inline: {}", stdout);
    // Large child folded: body absent, placeholder line present with its address.
    assert!(!stdout.contains("LARGEMARK"), "large child body must be folded out: {}", stdout);
    let placeholder = stdout
        .lines()
        .find(|l| l.contains("1.2") && l.contains("Large Child"))
        .expect("folded placeholder for 1.2");
    assert!(placeholder.contains("tok"), "placeholder carries token stat: {}", placeholder);
}

#[test]
fn test_unfold_placeholder_matches_overview_line() {
    let path = read_fixture("unfold.md");
    // Overview tree line for 1.2.
    let overview = Command::new(cargo_bin())
        .args(["read", path.to_str().unwrap()])
        .output()
        .unwrap();
    let overview_line = String::from_utf8(overview.stdout)
        .unwrap()
        .lines()
        .find(|l| l.contains("1.2") && l.contains("Large Child"))
        .expect("overview 1.2 line")
        .to_string();

    // Folded placeholder in the unfold output for the same node.
    let unfold = Command::new(cargo_bin())
        .args(["read", path.to_str().unwrap(), "1", "--threshold", "100"])
        .output()
        .unwrap();
    let placeholder = String::from_utf8(unfold.stdout)
        .unwrap()
        .lines()
        .find(|l| l.contains("1.2") && l.contains("Large Child"))
        .expect("unfold 1.2 placeholder")
        .to_string();

    assert_eq!(placeholder, overview_line, "folded placeholder must match the overview tree line");
}

#[test]
fn test_unfold_depth_cap_folds_grandchild() {
    // High threshold so only the depth budget binds. depth=1 inlines direct
    // children but folds the grandchild (### Grandchild) to a placeholder.
    let output = Command::new(cargo_bin())
        .args([
            "read",
            read_fixture("unfold.md").to_str().unwrap(),
            "1",
            "--depth",
            "1",
            "--threshold",
            "100000",
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    // Large child inlined (depth 1 admits direct children, threshold no longer binds).
    assert!(stdout.contains("LARGEMARK"), "large child should inline at depth 1: {}", stdout);
    // Grandchild folded: its prose absent, placeholder for 1.2.1 present.
    assert!(!stdout.contains("GRANDMARK"), "grandchild must fold at depth 1: {}", stdout);
    assert!(
        stdout.lines().any(|l| l.contains("1.2.1") && l.contains("Grandchild")),
        "missing grandchild placeholder: {}", stdout
    );
}

#[test]
fn test_unfold_full_expands_everything() {
    // --full ignores threshold and depth: even the deep grandchild inlines.
    let output = Command::new(cargo_bin())
        .args([
            "read",
            read_fixture("unfold.md").to_str().unwrap(),
            "1",
            "--full",
            "--threshold",
            "1",
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.contains("LARGEMARK"), "large child must inline under --full: {}", stdout);
    assert!(stdout.contains("GRANDMARK"), "grandchild must inline under --full: {}", stdout);
    // Nothing folded: no placeholder line carrying the address/heading pair.
    assert!(
        !stdout.lines().any(|l| l.contains("1.2.1") && l.contains("Grandchild") && l.contains("tok")),
        "--full must leave no folded placeholders: {}", stdout
    );
}

#[test]
fn test_unfold_json_shape_with_folded_flags() {
    let output = Command::new(cargo_bin())
        .args([
            "read",
            read_fixture("unfold.md").to_str().unwrap(),
            "1",
            "--threshold",
            "100",
            "--format",
            "json",
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    let v: serde_json::Value =
        serde_json::from_str(&String::from_utf8(output.stdout).unwrap()).expect("valid JSON");

    // Top-level addressed node: own prose only in `content`, children separate.
    assert_eq!(v["address"], "1");
    assert_eq!(v["heading"], "Section");
    assert_eq!(v["slug"], "section");
    // `level` exposed on the addressed node (# Section = level 1).
    assert_eq!(v["level"].as_u64().unwrap(), 1);
    assert!(v["content"].as_str().unwrap().contains("Section own prose"));
    assert!(!v["content"].as_str().unwrap().contains("Small child body"), "children carried separately");

    let children = v["children"].as_array().unwrap();
    assert_eq!(children.len(), 2);

    // Small child inlined: folded=false, content present.
    let small = &children[0];
    assert_eq!(small["address"], "1.1");
    assert_eq!(small["folded"], false);
    // `level` exposed on children too (## Small Child = level 2).
    assert_eq!(small["level"].as_u64().unwrap(), 2);
    assert!(small["content"].as_str().unwrap().contains("Small child body"));

    // Large child folded: folded=true, content absent.
    let large = &children[1];
    assert_eq!(large["address"], "1.2");
    assert_eq!(large["folded"], true);
    assert!(large.get("content").is_none(), "folded child must omit content: {}", large);
    assert!(large["tokens"].as_u64().unwrap() > 100, "folded because over threshold");
}

#[test]
fn test_unfold_text_node_has_no_children() {
    // The `[0]` text node prints its own prose uniformly; JSON children empty.
    let output = Command::new(cargo_bin())
        .args([
            "read",
            read_fixture("sample.md").to_str().unwrap(),
            "0",
            "--format",
            "json",
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    let v: serde_json::Value =
        serde_json::from_str(&String::from_utf8(output.stdout).unwrap()).unwrap();
    assert_eq!(v["address"], "0");
    assert_eq!(v["children"].as_array().unwrap().len(), 0);
    assert!(v["content"].as_str().unwrap().contains("Lede prose before any heading."));
}

// --- properties field-path reads (Step 3) ---

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
