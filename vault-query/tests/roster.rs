//! Asserts the three prose lint rosters agree with `registry::rule_names()`.
//!
//! The registry is what executes; the prose is what an agent reads to decide
//! whether a rule already exists. When the two drift, an agent concludes a
//! registered rule is absent and proposes building it a second time. This test
//! turns that disagreement into a build failure at the moment the rule is added,
//! which is the only moment anyone holds the context needed to write the doc row.
//!
//! The three rosters live outside the crate, under `home/agents/skills/vault/`.
//! `nix build .#vault-query` builds from a `lib.fileset` source that carries only
//! the files it lists, so both markdown files are named explicitly in the
//! `crateSrc` fileset in `flake.nix`. They therefore land at the same path
//! relative to `CARGO_MANIFEST_DIR` in the build sandbox as in a plain checkout,
//! and this test runs in the ordinary build loop with no extra command.
//!
//! Deliberately out of scope: generating the prose from the registry. The
//! hand-written "what it flags" wording carries reasoning a generated table
//! cannot, so the prose stays authored and disagreement is made loud instead.

use std::collections::BTreeSet;
use vault_query::commands::lint::registry;

const LINT_MD: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../home/agents/skills/vault/references/lint.md"
);
const SKILL_MD: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../home/agents/skills/vault/SKILL.md"
);

const SITE_RULES_TABLE: &str =
    "the Rules table in home/agents/skills/vault/references/lint.md (`## Rules`)";
const SITE_DATA_TABLE: &str = "the `data` per rule table in home/agents/skills/vault/references/lint.md (`### `data` per rule`)";
const SITE_SKILL_ROW: &str =
    "the `lint` row of the subcommands table in home/agents/skills/vault/SKILL.md";

/// Split a markdown table row into its trimmed cells.
///
/// A cell containing an escaped `\|` splits wrongly, which is harmless here: the
/// callers key off the first cell, and no roster row escapes a pipe.
fn table_cells(line: &str) -> Option<Vec<&str>> {
    let trimmed = line.trim();
    if !trimmed.starts_with('|') {
        return None;
    }
    Some(
        trimmed
            .trim_matches('|')
            .split('|')
            .map(str::trim)
            .collect(),
    )
}

/// The text between the first pair of backticks in a cell, if any.
///
/// Both roster tables open each row with a backticked rule name, so this doubles
/// as the row filter: the header cell (`Rule`) and the `---` separator carry no
/// backticks and drop out.
fn backticked(cell: &str) -> Option<&str> {
    let rest = cell.strip_prefix('`')?;
    let end = rest.find('`')?;
    Some(&rest[..end])
}

/// The lines under `heading`, up to the next heading of any level.
///
/// Returns `None` when the heading is absent, so a renamed section fails as
/// "section not found" instead of silently reporting every rule as missing.
fn section_lines<'a>(text: &'a str, heading: &str) -> Option<Vec<&'a str>> {
    let mut out = Vec::new();
    let mut inside = false;
    let mut found = false;
    for line in text.lines() {
        if line.starts_with('#') {
            if inside {
                break;
            }
            inside = line.trim() == heading;
            found |= inside;
            continue;
        }
        if inside {
            out.push(line);
        }
    }
    if found { Some(out) } else { None }
}

/// Rule names opening each row of the table under `heading`.
fn table_roster(text: &str, heading: &str) -> Option<Vec<String>> {
    Some(
        section_lines(text, heading)?
            .iter()
            .filter_map(|line| table_cells(line))
            .filter_map(|cells| cells.first().and_then(|c| backticked(c)).map(String::from))
            .collect(),
    )
}

/// Rule names from the one comma-separated sentence in SKILL.md's `lint` row.
///
/// The cell reads `Vault-wide lint: orphan-card (superseded entries exempt),
/// dangling-reference, ...`: everything after the first colon is the list, and
/// parenthetical asides are dropped so the commas separate names and nothing else.
///
/// The list cell is found by its colon rather than by column index, so reordering
/// the table's columns leaves this working. Indexing by position would fail the
/// moment a column moved ahead of `Description`, and it would fail as "no `lint`
/// row found" — which reads like the row was deleted rather than like the columns
/// moved, sending the reader after the wrong cause.
fn skill_roster(text: &str) -> Option<Vec<String>> {
    let row = text.lines().find(|line| {
        table_cells(line)
            .and_then(|cells| cells.first().and_then(|c| backticked(c)).map(String::from))
            .is_some_and(|first| first == "lint" || first.starts_with("lint "))
    })?;
    let cells = table_cells(row)?;
    let (_, list) = cells.iter().skip(1).find_map(|c| c.split_once(':'))?;

    let mut flat = String::new();
    let mut depth = 0usize;
    for ch in list.chars() {
        match ch {
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            _ if depth == 0 => flat.push(ch),
            _ => {}
        }
    }

    Some(
        flat.split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
            .collect(),
    )
}

#[test]
fn prose_rosters_match_registry() {
    let lint_md = std::fs::read_to_string(LINT_MD)
        .unwrap_or_else(|e| panic!("cannot read the lint reference at {LINT_MD}: {e}"));
    let skill_md = std::fs::read_to_string(SKILL_MD)
        .unwrap_or_else(|e| panic!("cannot read the vault skill at {SKILL_MD}: {e}"));

    let rules_table = table_roster(&lint_md, "## Rules")
        .unwrap_or_else(|| panic!("no `## Rules` section found in {LINT_MD}"));
    let data_table = table_roster(&lint_md, "### `data` per rule")
        .unwrap_or_else(|| panic!("no ``### `data` per rule`` section found in {LINT_MD}"));
    let skill_row = skill_roster(&skill_md).unwrap_or_else(|| {
        panic!("no `lint` row with a colon-introduced rule list found in {SKILL_MD}")
    });

    let sites = [
        (SITE_RULES_TABLE, rules_table),
        (SITE_DATA_TABLE, data_table),
        (SITE_SKILL_ROW, skill_row),
    ];

    // An empty roster means the extraction broke, not that every rule is
    // undocumented. Fail on that first so the message points at the parser.
    for (site, names) in &sites {
        assert!(
            !names.is_empty(),
            "extracted no rule names from {site} — the roster's shape changed and \
             tests/roster.rs no longer parses it"
        );
    }

    let registered: BTreeSet<String> = registry::rule_names()
        .into_iter()
        .map(String::from)
        .collect();

    let mut problems = Vec::new();
    for (site, names) in &sites {
        let mut listed = BTreeSet::new();
        for name in names {
            if !listed.insert(name.clone()) {
                problems.push(format!("`{name}` appears more than once in {site}"));
            }
        }
        for missing in registered.difference(&listed) {
            problems.push(format!(
                "`{missing}` is registered in registry::built_in_rules() but missing from {site} \
                 — add its row"
            ));
        }
        for stale in listed.difference(&registered) {
            problems.push(format!(
                "`{stale}` is listed in {site} but is absent from registry::rule_names() \
                 — drop the row, or register the rule"
            ));
        }
    }

    assert!(
        problems.is_empty(),
        "lint rule roster drift, {} problem(s):\n  {}\n\n\
         registry::built_in_rules() in vault-query/src/commands/lint/registry.rs is the \
         authority; the three prose rosters must list exactly the same names.",
        problems.len(),
        problems.join("\n  "),
    );
}
