//! Superseded/epistemic-tier labeling, downranking, and `--no-superseded` exclusion
//! across search / list / get / backlinks, plus the get multi-match arm.

mod common;
use common::*;

use std::process::Command;

/// regex search: a superseded entry matching the pattern is labeled "[superseded]" in output.
/// "Superseded card.md" has `superseded: true` and contains the unique token "xkqzflpbvmt".
#[test]
fn test_regex_labels_superseded_result() {
    let (stdout, code) = run_search(&["xkqzflpbvmt", "--regex"]);
    assert_eq!(code, 0, "regex search must exit 0; stdout: {}", stdout);
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
    let (stdout, code) = run_search(&["xkqzflpbvmt", "--regex", "--no-superseded"]);
    assert_eq!(code, 0, "regex search --no-superseded must exit 0; stdout: {}", stdout);
    assert!(
        stdout.trim().is_empty(),
        "--no-superseded must exclude the only matching superseded entry; stdout: {:?}",
        stdout
    );
}

/// `epistemic_status: superseded` must be excluded by get/backlinks/list under
/// --no-superseded — not just the legacy `superseded: true` flag. Before the
/// epistemic_tier dedup these three commands keyed off `is_superseded()` only and
/// leaked an `epistemic_status: superseded` entry as live (plan §4.6). The note
/// here carries NO legacy flag, so it exercises the fix specifically.
#[test]
fn test_epistemic_status_superseded_excluded_by_get_backlinks_list() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let cards = root.join("20 cards");
    std::fs::create_dir_all(&cards).unwrap();

    // Plain live card: the backlink target.
    std::fs::write(cards.join("Target.md"), "---\ntype: card\n---\n\nbody\n").unwrap();
    // Live card linking to Target.
    std::fs::write(
        cards.join("Live source.md"),
        "---\ntype: card\n---\n\nSee [[Target]].\n",
    )
    .unwrap();
    // epistemic_status: superseded card (no legacy `superseded: true`) linking to Target.
    std::fs::write(
        cards.join("Epi gone.md"),
        "---\ntype: card\nepistemic_status: superseded\n---\n\nSee [[Target]].\n",
    )
    .unwrap();

    let root_str = root.to_str().unwrap();

    // list --no-superseded drops the epistemic_status: superseded card.
    let out = Command::new(cargo_bin())
        .args(["list", "20 cards", "--vault-root", root_str, "--no-superseded"])
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        out.status.success(),
        "list must exit 0; stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(stdout.contains("Live source"), "list must keep the live source; stdout: {}", stdout);
    assert!(
        !stdout.contains("Epi gone"),
        "list --no-superseded must exclude epistemic_status: superseded card; stdout: {}",
        stdout
    );

    // backlinks --no-superseded drops the epistemic_status: superseded source.
    let out = Command::new(cargo_bin())
        .args([
            "backlinks",
            cards.join("Target.md").to_str().unwrap(),
            "--vault-root",
            root_str,
            "--no-superseded",
        ])
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        stdout.contains("Live source"),
        "backlinks must keep the live source; stdout: {}",
        stdout
    );
    assert!(
        !stdout.contains("Epi gone"),
        "backlinks --no-superseded must exclude epistemic_status: superseded source; stdout: {}",
        stdout
    );

    // get --no-superseded refuses to resolve the epistemic_status: superseded note.
    let out = Command::new(cargo_bin())
        .args(["get", "Epi gone", "--vault-root", root_str, "--no-superseded"])
        .output()
        .unwrap();
    assert!(
        !out.status.success(),
        "get --no-superseded must not resolve an epistemic_status: superseded note; stdout: {}",
        String::from_utf8_lossy(&out.stdout)
    );

    // Sanity: without the flag, get DOES resolve it — proving the exclusion is the
    // filter, not a missing file.
    let out = Command::new(cargo_bin())
        .args(["get", "Epi gone", "--vault-root", root_str])
        .output()
        .unwrap();
    assert!(
        out.status.success() && String::from_utf8_lossy(&out.stdout).contains("Epi gone"),
        "get without --no-superseded must resolve the note; stdout: {}",
        String::from_utf8_lossy(&out.stdout)
    );
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

    let cfg = cfg_for(&vault_root);

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

/// Backlog 21 (falsifiable): on the same query, a `certified` sibling outranks a
/// `provisional` one, which outranks a `superseded` one. Fails before the graded
/// `epistemic_tier` multiplier replaces the binary 0.3 downrank; passes after.
#[test]
fn test_search_graded_epistemic_tier_ranking() {
    let tmp = tempfile::tempdir().unwrap();
    let vault_root = tmp.path().to_path_buf();
    let cards_dir = vault_root.join("20 cards");
    std::fs::create_dir_all(&cards_dir).unwrap();

    // Three siblings with identical bodies (same unique token, same count) so the
    // raw BM25 scores tie and only the tier multiplier separates them.
    let body = "qzwxmtkpvbn qzwxmtkpvbn qzwxmtkpvbn qzwxmtkpvbn qzwxmtkpvbn\nqzwxmtkpvbn qzwxmtkpvbn qzwxmtkpvbn qzwxmtkpvbn qzwxmtkpvbn\n";
    std::fs::write(
        cards_dir.join("Certified card.md"),
        format!("---\ntype: card\nepistemic_status: certified\n---\n\n{body}"),
    )
    .unwrap();
    std::fs::write(
        cards_dir.join("Provisional card.md"),
        format!("---\ntype: card\nepistemic_status: provisional\n---\n\n{body}"),
    )
    .unwrap();
    std::fs::write(
        cards_dir.join("Superseded card.md"),
        format!("---\ntype: card\nepistemic_status: superseded\n---\n\n{body}"),
    )
    .unwrap();

    let cfg = cfg_for(&vault_root);

    let results = vault_query::commands::search::collect_bm25_results_filtered(
        "qzwxmtkpvbn",
        &cfg,
        None,
        10,
        &[],
        false, // keep all three; tier downrank applies
    )
    .unwrap();

    let pos = |needle: &str| {
        results
            .iter()
            .position(|r| r.path.contains(needle))
            .unwrap_or_else(|| panic!("{needle} not found in results"))
    };
    let cert = pos("Certified card");
    let prov = pos("Provisional card");
    let sup = pos("Superseded card");

    assert!(
        cert < prov && prov < sup,
        "expected certified < provisional < superseded by rank; got certified={cert} provisional={prov} superseded={sup}"
    );

    // The `epistemic_status: superseded` sibling collapses into the bottom tier:
    // it carries the `superseded` label even without the legacy `superseded: true`.
    assert!(
        results[sup].superseded,
        "epistemic_status: superseded must set the superseded label"
    );
    assert!(
        !results[prov].superseded,
        "provisional must NOT be labeled superseded — it is downranked, not retired"
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

/// get: a superseded entry resolves to its bare path (exit 0) without --no-superseded.
#[test]
fn test_get_resolves_superseded_path() {
    let (stdout, code) = run_get(&["superseded-card"]);
    assert_eq!(code, 0, "get must exit 0 for superseded entry without --no-superseded; stdout: {}", stdout);
    let line = stdout.trim();
    assert!(
        line.ends_with(".md") && !line.contains("[superseded]"),
        "get must emit only the resolved path, no marker; stdout: {}",
        stdout
    );
}

/// get --no-superseded: exits 1 for a superseded entry.
#[test]
fn test_get_no_superseded_exits_1() {
    let (_stdout, code) = run_get(&["superseded-card", "--no-superseded"]);
    assert_eq!(
        code, 1,
        "get --no-superseded must exit 1 for a superseded entry"
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

    let cfg = cfg_for(&vault_root);

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

    let cfg = cfg_for(&vault_root);

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
/// survives, get must resolve it normally (print its path).
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
    let paths_all = vault_query::slug::resolve_paths("shared-name", &cfg).unwrap();
    assert_eq!(paths_all.len(), 2, "expected 2 matches before filtering; got {:?}", paths_all);

    // With --no-superseded the superseded candidate should be dropped and the
    // single survivor resolved normally (exit 0, its path printed to stdout).
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
        stdout.contains("folder-b"),
        "get must print the surviving (non-superseded) candidate's path; stdout: {}",
        stdout
    );
    assert!(
        !stdout.contains("folder-a"),
        "get must not print the superseded candidate's path when --no-superseded is set; stdout: {}",
        stdout
    );
}

/// In the multi-match listing (no --no-superseded), every candidate is listed as
/// a bare absolute path, one per line, with no [superseded] labels.
#[test]
fn test_get_multi_match_lists_bare_paths() {
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

    // No labels: the listing is bare paths only.
    assert!(
        !stdout.contains("[superseded]"),
        "multi-match listing must not carry [superseded] labels; stdout: {}",
        stdout
    );

    // Both candidates appear, one bare path per line.
    let lines: Vec<&str> = stdout.lines().filter(|l| !l.trim().is_empty()).collect();
    assert_eq!(lines.len(), 2, "expected both candidate paths listed; stdout: {}", stdout);
    assert!(
        stdout.contains("folder-a") && stdout.contains("folder-b"),
        "both candidate paths must appear in the listing; stdout: {}",
        stdout
    );
}
