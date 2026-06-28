//! `read` overview / section / smart-unfold integration tests.

mod common;
use common::*;

use std::process::Command;

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

/// A vault-relative path (the bare pointer consult emits) resolves against the
/// configured `vault_root`, so `read "20 cards/Retry patterns.md"` runs from a
/// cwd that is not the vault root.
#[test]
fn test_read_resolves_vault_relative_path() {
    // Run from a temp cwd where the relative path does not exist, forcing the
    // vault_root fallback. `--vault-root` pins the corpus to the fixture vault.
    let cwd = tempfile::tempdir().unwrap();
    let output = Command::new(cargo_bin())
        .current_dir(cwd.path())
        .args([
            "read",
            "20 cards/Retry patterns.md",
            "--vault-root",
            fixture_dir().to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "vault-relative read must succeed; stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(
        stdout.contains("Retry patterns.md"),
        "overview must name the resolved file, got: {}",
        stdout
    );
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
