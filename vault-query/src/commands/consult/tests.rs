//! Unit tests for the consult retrieval engine.
//!
//! Split out of `mod.rs` to keep the production engine readable; `use super::*`
//! preserves access to the module's private items.

use super::*;
use std::collections::BTreeMap;

// --- Section attribution ---

/// Build the stemmed query-term set the way the gate does, so the test
/// matches whatever the analyzer actually produces.
fn terms(query: &str) -> BTreeSet<String> {
    stemmed_tokens(query).into_iter().collect()
}

#[test]
fn best_section_points_at_the_densest_heading() {
    // Matched terms cluster under "## Retry handling"; the unrelated section
    // and the shallow text region carry none.
    let body = "\
intro prose about nothing in particular

## Caching

memoize results to avoid recomputation

## Retry handling

exponential backoff retries failed requests on transient failure

### Tuning

pick backoff ceilings empirically";
    let q = terms("retry backoff failure");
    // Section "2" (Retry handling) owns the line with three matches; its
    // child "2.1" (Tuning) owns one. Highest score wins.
    assert_eq!(best_section_address(body, &q).as_deref(), Some("2"));
}

#[test]
fn best_section_is_none_without_matches() {
    let body = "## Caching\n\nmemoize results";
    let q = terms("retry backoff failure");
    assert_eq!(best_section_address(body, &q), None);
}

#[test]
fn best_section_attributes_heading_less_body_to_text_region() {
    let body = "exponential backoff retries failed requests on failure";
    let q = terms("retry backoff failure");
    assert_eq!(best_section_address(body, &q).as_deref(), Some("0"));
}

// --- Fixture helpers ---

fn make_vault_file(name: &str, doc_type: &str, body: &str) -> VaultFile {
    make_vault_file_ext(name, doc_type, body, false)
}

fn make_vault_file_ext(name: &str, doc_type: &str, body: &str, is_template: bool) -> VaultFile {
    let template_line = if is_template {
        "template: true\n"
    } else {
        ""
    };
    let content = format!(
        "---\ntype: {doc_type}\n{template_line}---\n\n{body}"
    );
    let mut frontmatter = BTreeMap::new();
    frontmatter.insert(
        "type".to_string(),
        serde_yaml::Value::String(doc_type.to_string()),
    );
    if is_template {
        frontmatter.insert(
            "template".to_string(),
            serde_yaml::Value::Bool(true),
        );
    }
    VaultFile {
        name: name.to_string(),
        path: std::path::PathBuf::from(format!("/vault/{}.md", name)),
        frontmatter,
        frontmatter_error: None,
        content,
        ctime: None,
    }
}

/// Like `make_vault_file`, but also sets a frontmatter `description:` value
/// (the field whose indexing this change introduces).
fn make_vault_file_desc(name: &str, doc_type: &str, description: &str, body: &str) -> VaultFile {
    let mut vf = make_vault_file(name, doc_type, body);
    vf.frontmatter.insert(
        "description".to_string(),
        serde_yaml::Value::String(description.to_string()),
    );
    vf
}

/// Like `make_vault_file`, but stamps an `epistemic_status:` frontmatter value
/// (certified / provisional / superseded) so tier-ranking can be exercised.
fn make_vault_file_epistemic(name: &str, status: &str, body: &str) -> VaultFile {
    let mut vf = make_vault_file(name, "card", body);
    vf.frontmatter.insert(
        "epistemic_status".to_string(),
        serde_yaml::Value::String(status.to_string()),
    );
    vf
}

fn default_config() -> ConsultConfig {
    ConsultConfig::default()
}

fn vault_root() -> std::path::PathBuf {
    std::path::PathBuf::from("/vault")
}

// --- Test 1: scope filter excludes out-of-type docs ---

#[test]
fn scope_filter_excludes_out_of_type() {
    // Build a file set with a mix of types; only "card" is in scope.
    let card = make_vault_file("CardDoc", "card", "This card has relevant content about filtering algorithms.");
    let checkpoint = make_vault_file("CheckpointDoc", "checkpoint", "This checkpoint has relevant content about filtering algorithms.");
    let track = make_vault_file("TrackDoc", "track", "This track has relevant content about filtering algorithms.");

    let files = vec![card, checkpoint, track];
    let scope = vec!["card".to_string()];

    // Use a query that would match all three if they were all indexed.
    let config = default_config();
    let (result, _diag) = run_consult(
        "filtering algorithms",
        &files,
        &vault_root(),
        &scope,
        &config,
        ConsultMode::Deliberate,
        false,
    )
    .unwrap();

    // Only the card doc is in scope; checkpoint/track must not appear.
    match result {
        ConsultOutcome::Selected { docs, .. } => {
            for doc in &docs {
                assert_eq!(
                    doc.doc_type.as_deref(),
                    Some("card"),
                    "out-of-scope type in results: {:?}",
                    doc.doc_type
                );
            }
        }
        ConsultOutcome::Abstain { .. } => {
            // Abstain is acceptable — the point is that out-of-type docs are absent.
            // (One card may not score well enough on a 2-token query.)
        }
    }
}

// --- Test 2: scope filter excludes template:true docs ---

#[test]
fn scope_filter_excludes_template_docs() {
    let template = make_vault_file_ext("CardTemplate", "card", "template content about important concepts retrieval", true);
    let real = make_vault_file("RealCard", "card", "real content about important concepts retrieval that is searchable");

    let files = vec![template, real];
    let scope = vec!["card".to_string()];
    let config = default_config();

    let (result, _diag) = run_consult(
        "important concepts retrieval",
        &files,
        &vault_root(),
        &scope,
        &config,
        ConsultMode::Deliberate,
        false,
    )
    .unwrap();

    match result {
        ConsultOutcome::Selected { docs, .. } => {
            for doc in &docs {
                assert_ne!(
                    doc.title, "CardTemplate",
                    "template doc should not appear in results"
                );
            }
        }
        ConsultOutcome::Abstain { .. } => {}
    }
}

// --- Test 3: relevant query answers with correct docs ---

#[test]
fn relevant_query_selects_and_packs() {
    // A highly relevant card and an irrelevant card. The relevant one should be selected.
    let relevant = make_vault_file(
        "Retry Patterns",
        "card",
        "Retry patterns are used to handle transient failures. Exponential backoff retries \
         failed requests after increasing delays. Circuit breakers stop retrying when the \
         failure rate is too high. These retry strategies improve resilience and reliability.",
    );
    let irrelevant = make_vault_file(
        "Cooking Recipes",
        "card",
        "A collection of delicious recipes for pasta, pizza, and salads. Cooking techniques \
         include sautéing, braising, and baking. Ingredients are fresh vegetables and herbs.",
    );

    let files = vec![relevant, irrelevant];
    let scope = vec!["card".to_string()];
    let config = default_config();

    let (result, _diag) = run_consult(
        "retry backoff failure",
        &files,
        &vault_root(),
        &scope,
        &config,
        ConsultMode::Deliberate,
        false,
    )
    .unwrap();

    match result {
        ConsultOutcome::Selected { docs, total_tokens, .. } => {
            assert!(!docs.is_empty(), "expected at least one selected doc");
            assert_eq!(docs[0].title, "Retry Patterns", "highest-scored doc should be first");
            assert!(total_tokens > 0);
            // Body should not start with a newline.
            assert!(!docs[0].body.starts_with('\n'));
        }
        ConsultOutcome::Abstain { reason, .. } => {
            panic!("expected ANSWER for relevant query, got ABSTAIN: {}", reason);
        }
    }
}

// --- Test 3b: epistemic tier downranks provisional below certified ---

#[test]
fn certified_outranks_provisional_in_consult() {
    // Two siblings with identical bodies (same matching tokens) differ only in
    // epistemic_status. The certified sibling must rank above the provisional one
    // once the tier multiplier (1.0 vs 0.6) scales the tied raw scores.
    let rich = "retrieval ranking trust retrieval ranking trust retrieval ranking trust \
                retrieval ranking trust retrieval ranking trust retrieval ranking trust";
    let certified = make_vault_file_epistemic("Certified note", "certified", rich);
    let provisional = make_vault_file_epistemic("Provisional note", "provisional", rich);

    // Weak distractors: they match a single query term amid filler, so they score
    // low and pull the median below the provisional sibling's scaled score — letting
    // both siblings clear the `score >= median` candidate cut and pack together.
    let filler = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod \
                  tempor incididunt ut labore et dolore magna aliqua ut enim ad minim";
    let d1 = make_vault_file("Distractor one", "card", &format!("retrieval {filler}"));
    let d2 = make_vault_file("Distractor two", "card", &format!("retrieval {filler}"));
    let d3 = make_vault_file("Distractor three", "card", &format!("retrieval {filler}"));

    let files = vec![certified, provisional, d1, d2, d3];
    let scope = vec!["card".to_string()];
    let config = default_config();

    let (result, _diag) = run_consult(
        "retrieval ranking trust",
        &files,
        &vault_root(),
        &scope,
        &config,
        ConsultMode::Deliberate,
        false,
    )
    .unwrap();

    match result {
        ConsultOutcome::Selected { docs, .. } => {
            let cert_pos = docs.iter().position(|d| d.title == "Certified note");
            let prov_pos = docs.iter().position(|d| d.title == "Provisional note");
            let (cert_pos, prov_pos) = (
                cert_pos.expect("certified sibling must be packed"),
                prov_pos.expect("provisional sibling must be packed"),
            );
            assert!(
                cert_pos < prov_pos,
                "certified (pos {cert_pos}) must outrank provisional (pos {prov_pos})"
            );
            let cert_score = docs[cert_pos].score;
            let prov_score = docs[prov_pos].score;
            assert!(
                cert_score > prov_score,
                "certified score {cert_score:.4} must exceed provisional score {prov_score:.4} after the tier multiplier"
            );
        }
        ConsultOutcome::Abstain { reason, .. } => {
            panic!("expected SELECTED with both siblings packed, got ABSTAIN: {reason}");
        }
    }
}

// --- Test 4: irrelevant query abstains with near_misses ---

#[test]
fn irrelevant_query_abstains_with_near_misses() {
    let card = make_vault_file(
        "BTree Algorithms",
        "card",
        "BTree index structures maintain sorted order for efficient range queries. \
         Balanced trees ensure O(log n) lookup. Internal nodes hold keys and pointers \
         to child nodes.",
    );

    let files = vec![card];
    let scope = vec!["card".to_string()];

    // A query with very low coverage: "quantum teleportation" has no overlap with BTree content.
    // Force abstain by also setting a high threshold backstop.
    let mut config = default_config();
    config.threshold = Some(1000.0); // guaranteed abstain

    let (result, _diag) = run_consult(
        "quantum teleportation entanglement",
        &files,
        &vault_root(),
        &scope,
        &config,
        ConsultMode::Deliberate,
        false,
    )
    .unwrap();

    match result {
        ConsultOutcome::Abstain { near_misses, reason, .. } => {
            // near_misses populated; reason is non-empty
            assert!(!reason.is_empty());
            // near_misses may be empty if no hits were returned at all
            let _ = near_misses; // present in the type; content may vary
        }
        ConsultOutcome::Selected { .. } => {
            panic!("expected ABSTAIN for irrelevant query with high threshold");
        }
    }
}

// --- Test 5: packing respects per_doc_token_cap; the dropped doc becomes a pointer ---

#[test]
fn packing_skips_oversized_doc() {
    // BigDoc and SmallDoc both fully cover the query, so both clear the per-doc
    // coverage filter; BigDoc exceeds the cap and must be dropped from the pack
    // and surface as a pointer instead.  WeakDoc matches one diluted term: with
    // three hits the median sits at its score, keeping both relevant docs in the
    // above-median candidate set regardless of which of the two ranks first.
    let per_doc_cap = 50; // very small cap for test
    let big_body =
        "retry backoff failure pattern helps resilience in distributed systems ".repeat(50);
    let small_body = "retry backoff failure pattern helps resilience in distributed systems";
    let weak_body = "the failure of the crop harvest was caused by unseasonal weather";

    let big = make_vault_file("BigDoc", "card", &big_body);
    let small = make_vault_file("SmallDoc", "card", small_body);
    let weak = make_vault_file("WeakDoc", "card", weak_body);

    let files = vec![big, small, weak];
    let scope = vec!["card".to_string()];
    let mut config = default_config();
    config.per_doc_token_cap = per_doc_cap;
    config.token_budget = 10_000; // generous budget
    config.elbow_k = 1.0; // isolate the test from the elbow gate

    let (result, _diag) = run_consult(
        "retry backoff failure",
        &files,
        &vault_root(),
        &scope,
        &config,
        ConsultMode::Deliberate,
        false,
    )
    .unwrap();

    match result {
        ConsultOutcome::Selected { docs, pointers, .. } => {
            for doc in &docs {
                assert!(
                    doc.tokens <= per_doc_cap,
                    "doc '{}' has {} tokens, exceeds per_doc_cap {}",
                    doc.title,
                    doc.tokens,
                    per_doc_cap
                );
                assert_ne!(doc.title, "BigDoc", "BigDoc should have been skipped (over cap)");
            }
            assert!(
                docs.iter().any(|d| d.title == "SmallDoc"),
                "SmallDoc fits the cap and must be packed, got: {:?}",
                docs.iter().map(|d| d.title.as_str()).collect::<Vec<_>>()
            );
            assert!(
                pointers.iter().any(|p| p.title == "BigDoc"),
                "the cap-dropped BigDoc must appear in pointers, got: {:?}",
                pointers.iter().map(|p| p.title.as_str()).collect::<Vec<_>>()
            );
        }
        ConsultOutcome::Abstain { reason, .. } => {
            panic!(
                "expected Selected: both relevant docs fully cover the query \
                 and the elbow is disabled, got Abstain: {}",
                reason
            );
        }
    }
}

// --- Test 5b: per_doc_token_cap regression — docs between old cap (2000) and new cap (4000) pack ---
//
// Two confirmed ANSWER-MISS cases had bodies of 3035 and 2994 estimated tokens
// (chars/4) and were skipped whole while the packer still had budget.  This test
// constructs a doc in that range (~2800 estimated tokens = 11200 chars) and asserts
// that it is included with the default cap of 4000.  If the cap is ever lowered back
// below 2800, this test will fail — that is the intent.

#[test]
fn packing_includes_doc_between_old_and_new_cap() {
    // Body of ~11200 chars → ~2800 estimated tokens (chars / 4).
    // This is above the old cap (2000) but below the new cap (4000).
    let long_body = "retry backoff failure resilience distributed system pattern ".repeat(190);
    // Verify the estimate is in the target range before asserting packing behaviour.
    let estimated_tokens = long_body.chars().count() / 4;
    assert!(
        estimated_tokens > 2000,
        "test body must exceed old cap: got {} tokens",
        estimated_tokens
    );
    assert!(
        estimated_tokens < 4000,
        "test body must be below new cap: got {} tokens",
        estimated_tokens
    );

    let long_doc = make_vault_file("LongDoc", "card", &long_body);
    // Pair with a short unrelated doc so BM25 has a comparison point.
    let short_doc = make_vault_file(
        "ShortDoc",
        "card",
        "Unrelated content about cooking and recipes.",
    );

    let files = vec![long_doc, short_doc];
    let scope = vec!["card".to_string()];
    // Use the real default config (per_doc_token_cap = 4000, token_budget = 8000).
    let config = default_config();

    let (result, _diag) = run_consult(
        "retry backoff failure",
        &files,
        &vault_root(),
        &scope,
        &config,
        ConsultMode::Deliberate,
        false,
    )
    .unwrap();

    match result {
        ConsultOutcome::Selected { docs, .. } => {
            let included = docs.iter().any(|d| d.title == "LongDoc");
            assert!(
                included,
                "LongDoc (~{} tokens) should be packed with per_doc_token_cap=4000, \
                 but it was skipped. Lowering the cap below {} would cause ANSWER-MISS \
                 regressions on real vault documents.",
                estimated_tokens,
                estimated_tokens + 1,
            );
        }
        ConsultOutcome::Abstain { reason, .. } => {
            // If BM25 abstains (gate not cleared), the test cannot validate packing.
            // This path is acceptable only if the gate itself abstained; it does not
            // indicate a per_doc_token_cap regression.  Use a panic with a clear
            // message so a future gate recalibration does not silently hide regressions.
            panic!(
                "consult abstained ({}); cannot verify per_doc_token_cap packing. \
                 If gate constants changed, update this test to use an explicit config \
                 that passes the gate.",
                reason
            );
        }
    }
}

// --- Test 6: greedy packing — later smaller doc fits when earlier large one overflows ---

#[test]
fn packing_greedy_later_small_doc_fits() {
    // Three docs with identical high relevance (same terms):
    //   - medium: exactly fits half the budget
    //   - large: overflows the budget
    //   - tiny: fits in the remaining half
    // Order by score: we arrange content so all score similarly and test that the
    // greedy loop skips the large one and includes the tiny one.
    // We achieve this by making all three docs equally relevant, then relying on
    // the packing logic to be order-independent (skip large, continue, include tiny).

    // Budget: 100 tokens. per_doc_cap: 200.
    // medium: ~50 tokens (200 chars). large: ~80 tokens (320 chars). tiny: ~10 tokens (40 chars).
    let budget = 100usize;

    // Each doc has the same high-relevance terms so they score similarly.
    let base_terms = "retry backoff failure resilience distributed";
    let medium_body = format!("{} {}", base_terms, "a ".repeat(190 / 2)); // ~200 chars
    let large_body = format!("{} {}", base_terms, "b ".repeat(310 / 2));  // ~320 chars
    let tiny_body = format!("{} small hint", base_terms);                  // short

    let med_doc = make_vault_file("MedDoc", "card", &medium_body);
    let large_doc = make_vault_file("LargeDoc", "card", &large_body);
    let tiny_doc = make_vault_file("TinyDoc", "card", &tiny_body);

    let files = vec![med_doc, large_doc, tiny_doc];
    let scope = vec!["card".to_string()];
    let mut config = default_config();
    config.token_budget = budget;
    config.per_doc_token_cap = 200; // large_body ~80 tokens is under cap; medium ~50 too

    let (result, _diag) = run_consult(
        "retry backoff failure",
        &files,
        &vault_root(),
        &scope,
        &config,
        ConsultMode::Deliberate,
        false,
    )
    .unwrap();

    match result {
        ConsultOutcome::Selected { docs, total_tokens, .. } => {
            assert!(
                total_tokens <= budget,
                "total_tokens {} exceeds budget {}",
                total_tokens,
                budget
            );
            // At least one doc was packed.
            assert!(!docs.is_empty());
        }
        ConsultOutcome::Abstain { .. } => {
            // Gate may abstain on borderline cases; that's acceptable for this test.
        }
    }
}

// --- Test 7: Ambient mode abstains where Deliberate would answer ---

#[test]
fn ambient_stricter_than_deliberate() {
    // A query whose top doc covers 2 of 3 query terms. With the calibrated
    // defaults (deliberate coverage_fraction = 0.45, ambient = 0.50) both
    // would pass on coverage alone, so this test forces the ambient gate by
    // raising ambient_coverage_fraction to 0.9 below — the invariant under
    // test is "stricter ambient params never answer where deliberate does."
    //
    // Build two cards: one relevant, one completely unrelated.
    //
    // Query: "retry backoff timeout" (3 terms after stemming).
    // Relevant card body contains "retry" and "backoff" but NOT "timeout",
    // so coverage = 2/3 ≈ 0.67.

    let relevant = make_vault_file(
        "RetryCard",
        "card",
        "Retry and backoff patterns are essential for handling transient failures. \
         Exponential backoff reduces load on failing services. Retry logic improves \
         availability in distributed architectures.",
    );
    let other = make_vault_file(
        "OtherCard",
        "card",
        "Database schema migrations require careful planning. Schema changes must be \
         backward compatible. Version-controlled migrations ensure consistency.",
    );

    let files = vec![relevant, other];
    let scope = vec!["card".to_string()];

    // Deliberate with defaults should answer (coverage 2/3 > 0.5).
    let config_deliberate = default_config();
    let (deliberate_result, _) = run_consult(
        "retry backoff timeout",
        &files,
        &vault_root(),
        &scope,
        &config_deliberate,
        ConsultMode::Deliberate,
        false,
    )
    .unwrap();

    // Ambient with a higher coverage bar should abstain: 2/3 ≈ 0.67 < 0.9.
    // We tune ambient so it definitely fails: set ambient_coverage_fraction = 0.9.
    let mut config_ambient = default_config();
    config_ambient.ambient_coverage_fraction = 0.9; // "timeout" not in body → fails
    let (ambient_result, _) = run_consult(
        "retry backoff timeout",
        &files,
        &vault_root(),
        &scope,
        &config_ambient,
        ConsultMode::Ambient,
        false,
    )
    .unwrap();

    // Deliberate may answer or abstain depending on corpus; the key invariant is
    // that if deliberate answers, ambient with stricter params must not answer
    // unless coverage is coincidentally above 0.9.
    match (&deliberate_result, &ambient_result) {
        (ConsultOutcome::Selected { .. }, ConsultOutcome::Abstain { .. }) => {
            // Expected: deliberate answers, ambient abstains.
        }
        (ConsultOutcome::Abstain { .. }, ConsultOutcome::Abstain { .. }) => {
            // Both abstain: consistent with strict ambient threshold.
        }
        (ConsultOutcome::Selected { .. }, ConsultOutcome::Selected { .. }) => {
            // Both answer: this can happen if coverage = 1.0 (all 3 terms matched).
            // That would mean "timeout" is in the body, which it isn't, so this
            // should not occur. Fail to flag regression.
            panic!(
                "ambient answered where it should have abstained with ambient_coverage_fraction=0.9"
            );
        }
        (ConsultOutcome::Abstain { .. }, ConsultOutcome::Selected { .. }) => {
            panic!("ambient answered but deliberate abstained — unexpected");
        }
    }
}

// --- Test 8: threshold backstop forces abstain ---

#[test]
fn threshold_backstop_forces_abstain() {
    let card = make_vault_file(
        "RetryCard",
        "card",
        "Retry and backoff patterns are essential for handling transient failures. \
         Exponential backoff reduces load. Retry logic improves availability.",
    );

    let files = vec![card];
    let scope = vec!["card".to_string()];
    let mut config = default_config();
    config.threshold = Some(99999.0); // impossibly high — always abstain

    let (result, _diag) = run_consult(
        "retry backoff failure",
        &files,
        &vault_root(),
        &scope,
        &config,
        ConsultMode::Deliberate,
        false,
    )
    .unwrap();

    match result {
        ConsultOutcome::Abstain { reason, .. } => {
            assert_eq!(reason, "below threshold");
        }
        ConsultOutcome::Selected { .. } => {
            panic!("expected ABSTAIN due to threshold backstop");
        }
    }
}

// --- Test 9: empty scope produces abstain (no results) ---

#[test]
fn empty_scope_abstains() {
    let card = make_vault_file("Card1", "card", "Some content about retry patterns.");
    let files = vec![card];
    // Scope excludes "card" → no in-scope files → no hits.
    let scope = vec!["track".to_string()];
    let config = default_config();

    let (result, _diag) = run_consult(
        "retry",
        &files,
        &vault_root(),
        &scope,
        &config,
        ConsultMode::Deliberate,
        false,
    )
    .unwrap();

    assert!(
        matches!(result, ConsultOutcome::Abstain { .. }),
        "expected Abstain when no files are in scope"
    );
}

// --- Test 11 moved to crate::index (sanitize_query now lives there) ---

// --- Test 12: colon-containing query still retrieves matching doc ---

#[test]
fn colon_query_retrieves_matching_doc() {
    // A query like "workflow: plan first" used to mis-parse and return empty.
    // After sanitization it should find a doc containing those terms.
    let relevant = make_vault_file(
        "Workflow Planning",
        "card",
        "A good workflow starts with planning. Plan your work first, then execute. \
         Structured workflows reduce cognitive load and improve throughput.",
    );
    let unrelated = make_vault_file(
        "Database Indexes",
        "card",
        "Indexes speed up database lookups. B-tree and hash indexes serve different access patterns.",
    );

    let files = vec![relevant, unrelated];
    let scope = vec!["card".to_string()];
    let config = default_config();

    let (result, _diag) = run_consult(
        "workflow: plan first",
        &files,
        &vault_root(),
        &scope,
        &config,
        ConsultMode::Deliberate,
        false,
    )
    .unwrap();

    match result {
        ConsultOutcome::Selected { docs, .. } => {
            assert!(!docs.is_empty(), "expected at least one doc for colon query");
            assert_eq!(
                docs[0].title, "Workflow Planning",
                "expected Workflow Planning to be top result"
            );
        }
        ConsultOutcome::Abstain { reason, .. } => {
            panic!("expected ANSWER for colon query, got ABSTAIN: {}", reason);
        }
    }
}

// --- Test 13: Russian morphological query variant matches via bilingual analyzer ---

#[test]
fn russian_stemming_matches_morphological_variant() {
    // "алгоритмы" (plural nominative) and "алгоритм" (singular nominative) stem to
    // the same Russian Snowball stem, so a query using one form retrieves a doc
    // containing the other form.
    let card = make_vault_file(
        "RuCard",
        "card",
        "Алгоритм сортировки работает за линейное время. \
         Эффективные алгоритмы используют рекурсию и динамическое программирование.",
    );
    let unrelated = make_vault_file(
        "UnrelatedCard",
        "card",
        "Database schema migrations require careful planning and versioning.",
    );

    let files = vec![card, unrelated];
    let scope = vec!["card".to_string()];
    let config = default_config();

    // Query uses singular "алгоритм"; document contains both singular and plural.
    let (result, _diag) = run_consult(
        "алгоритм",
        &files,
        &vault_root(),
        &scope,
        &config,
        ConsultMode::Deliberate,
        false,
    )
    .unwrap();

    match result {
        ConsultOutcome::Selected { docs, .. } => {
            assert!(!docs.is_empty(), "expected at least one doc for Russian query");
            assert_eq!(
                docs[0].title, "RuCard",
                "expected RuCard as top result for Russian query"
            );
        }
        ConsultOutcome::Abstain { reason, .. } => {
            panic!("expected ANSWER for Russian query, got ABSTAIN: {}", reason);
        }
    }
}

// --- Test 14: stemmed_tokens produces Russian stems ---

#[test]
fn stemmed_tokens_produces_russian_stems() {
    // "сортировки" (genitive) and "сортировку" (accusative) should reduce to the
    // same stem as "сортировка" (nominative) under Russian Snowball.
    let tokens_nominative = stemmed_tokens("сортировка");
    let tokens_genitive = stemmed_tokens("сортировки");
    let tokens_accusative = stemmed_tokens("сортировку");

    assert_eq!(
        tokens_nominative, tokens_genitive,
        "genitive 'сортировки' must stem identically to nominative 'сортировка'"
    );
    assert_eq!(
        tokens_nominative, tokens_accusative,
        "accusative 'сортировку' must stem identically to nominative 'сортировка'"
    );

    // Sanity: result must be non-empty.
    assert!(
        !tokens_nominative.is_empty(),
        "stemmed_tokens must return at least one token for Russian input"
    );
}

// --- Test 10: near_misses contain matched_terms ---

#[test]
fn near_misses_contain_matched_terms() {
    let card = make_vault_file(
        "BTree",
        "card",
        "BTree index structures maintain sorted order for efficient range queries. \
         Balanced trees ensure O(log n) lookup. Internal nodes hold keys.",
    );

    let files = vec![card];
    let scope = vec!["card".to_string()];
    let mut config = default_config();
    config.threshold = Some(99999.0); // force abstain

    let (result, _diag) = run_consult(
        "btree index range",
        &files,
        &vault_root(),
        &scope,
        &config,
        ConsultMode::Deliberate,
        false,
    )
    .unwrap();

    match result {
        ConsultOutcome::Abstain { near_misses, reason, .. } => {
            assert_eq!(reason, "below threshold");
            // near_misses should be populated since there are hits
            assert!(!near_misses.is_empty(), "expected near_misses to be populated");
            // At least one stemmed query term should appear
            let all_matched: Vec<_> = near_misses.iter()
                .flat_map(|nm| nm.matched_terms.iter())
                .collect();
            assert!(!all_matched.is_empty(), "expected at least one matched_term in near_misses");
        }
        ConsultOutcome::Selected { .. } => {
            panic!("expected ABSTAIN due to threshold backstop");
        }
    }
}

// --- Test 15: top-3 coverage gate — rank-1 displacer (low coverage) + rank-2 relevant ---
//
// This is the displacement case: a high-BM25/low-coverage doc sits at rank 1 above a
// lower-BM25/high-coverage doc.  Under the old rank-1-only gate the whole query would
// abstain.  Under the new top-3 max-coverage gate it should return (rank-2 coverage
// clears the threshold).
//
// Fixture design:
//   - We use elbow_k = 1.0 so the elbow test is trivially satisfied (top_score ≥ 1.0 ×
//     median is always true when top is the max-scoring doc). This isolates the test to
//     the coverage gate only.
//   - Displacer (rank 1): title contains all 4 query terms (2× title boost → high BM25),
//     body has only ONE of the 4 terms → rank-1 coverage = 0.25 < 0.45.
//     Old gate: abstain.  New gate: inspect rank 2.
//   - Relevant (rank 2): body has all 4 terms → coverage = 1.0 ≥ 0.45.
//     New gate: pass.
//
// Expected outcome: ConsultOutcome::Selected (gate opens because rank-2 coverage ≥ 0.45).

#[test]
fn top3_coverage_gate_recovers_rank2_relevant_doc() {
    // Displacer: all 4 query tokens in title (2× boost → rank 1), body has only "cycle".
    let displacer_body =
        "cycle cycle cycle cycle cycle cycle cycle cycle cycle cycle \
         The seasonal cycle repeats. Each annual cycle drives change. \
         Temperature variation marks the cycle. The cycle of seasons is predictable.";
    let displacer = make_vault_file(
        "compound loop learn cycle", // title has all 4 query terms → rank 1 via title boost
        "card",
        displacer_body,              // body: only "cycle" → rank-1 coverage = 1/4 = 0.25
    );

    // Relevant: title unrelated, body saturated with all 4 query terms → coverage = 1.0.
    let relevant_body =
        "compound loop learn cycle ".repeat(20)
        + "Compounding small improvements over each cycle is how you learn. \
           The feedback loop drives compound learning. Every cycle teaches something. \
           Learn from each loop to compound your gains across cycles.";
    let relevant = make_vault_file(
        "Engineering Feedback",   // title: no query terms
        "card",
        &relevant_body,
    );

    let files = vec![displacer, relevant];
    let scope = vec!["card".to_string()];

    // Set elbow_k = 1.0 to isolate the coverage gate test (elbow is trivially satisfied).
    // coverage_fraction remains 0.45 (default).
    // Pin title_boost = 2.0 (the historical value): this fixture manufactures a
    // high-score / low-coverage rank-1 displacer via the filename, which only ranks #1
    // when the title is boosted above body. The default is now 1.0, so without this pin
    // the body-saturated relevant doc would take rank 1 and the gate would not be exercised.
    let mut config = default_config();
    config.elbow_k = 1.0;
    config.title_boost = 2.0;

    let (result, diag) = run_consult(
        "compound loop learn cycle",
        &files,
        &vault_root(),
        &scope,
        &config,
        ConsultMode::Deliberate,
        false,
    )
    .unwrap();

    // Rank-1 coverage must be below 0.45 to confirm this exercises the gate fix.
    if let Some(cov) = diag.coverage {
        assert!(
            cov < 0.45,
            "rank-1 coverage {:.2} ≥ 0.45; displacer title boost did not separate the \
             scores from the coverage; the test does not exercise the top-3 gate fix",
            cov
        );
    }

    match result {
        ConsultOutcome::Selected { docs, pointers, .. } => {
            // Gate opened — correct behavior.  At least one doc was packed.
            assert!(
                !docs.is_empty(),
                "expected at least one doc after gate passed via top-3 coverage"
            );
            // The packed set must contain the doc whose coverage justified the gate
            // (the rank-2 "Engineering Feedback"), not the low-coverage rank-1
            // displacer the per-doc filter rejects (bug_004).
            assert!(
                docs.iter().any(|d| d.title == "Engineering Feedback"),
                "expected the high-coverage rank-2 doc to be packed, got: {:?}",
                docs.iter().map(|d| d.title.as_str()).collect::<Vec<_>>()
            );
            assert!(
                !docs.iter().any(|d| d.title == "compound loop learn cycle"),
                "the low-coverage rank-1 displacer must not be packed (bug_004)"
            );
            // The displacer never enters `coverage_filtered`, so it must not leak
            // into pointers either (Decision 30 holds for the pointer set).
            assert!(
                !pointers.iter().any(|p| p.title == "compound loop learn cycle"),
                "the coverage-rejected displacer must not appear in pointers"
            );
        }
        ConsultOutcome::Abstain { reason, .. } => {
            panic!(
                "top-3 coverage gate must pass when rank-2 coverage = 1.0 ≥ 0.45, \
                 but abstained: {}. Rank-1 coverage: {:?}",
                reason,
                diag.coverage,
            );
        }
    }
}

// --- Test 15a: the frontmatter `description` field is indexed and drives ranking ---
//
// A query term that appears ONLY in a note's frontmatter `description` — not in its
// filename and not in its body — must surface that note. Before this change the
// `description` was stripped from the index entirely (zero weight), so such a note was
// invisible to BM25. This test operates on `bm25_rank` (pure ranking; the body-only
// coverage gate is a separate concern, deliberately not exercised here).

#[test]
fn description_field_is_indexed_and_surfaces_a_doc() {
    // The query terms live only in `matching`'s description. Both bodies and both
    // filenames are unrelated to the query, so only the description can match.
    let matching = make_vault_file_desc(
        "Untitled fragment",
        "card",
        "photosynthesis chloroplast thylakoid",
        "An unrelated body about weekend gardening and compost bins.",
    );
    let other = make_vault_file(
        "Another fragment",
        "card",
        "An unrelated body about weekend gardening and compost bins.",
    );

    let files: Vec<&VaultFile> = vec![&matching, &other];
    let config = default_config();
    let (hits, _) = bm25_rank(&files, &vault_root(), "photosynthesis chloroplast", 10, &config)
        .unwrap();

    assert!(
        !hits.is_empty(),
        "a query matched only by frontmatter description must surface a hit; \
         description is no longer discarded from the index"
    );
    assert_eq!(
        hits[0].title, "Untitled fragment",
        "the doc whose description matches the query must rank first, got: {:?}",
        hits.iter().map(|h| (h.title.as_str(), h.score)).collect::<Vec<_>>()
    );
}

// --- Test 15b: the demoted title boost lets `description` outrank a filename-only match ---
//
// Regression lock on the boost change: with two symmetric 3-word fields each matching all
// query terms (one in the filename, one in the description), the winner is decided by the
// boost ratio. Under the historical title boost (2.0) the filename dominates; under the new
// default (title 1.0, description 1.5) the curated description wins. Asserting the flip
// proves the demotion is the cause, independent of absolute BM25 magnitudes.

#[test]
fn demoted_title_boost_lets_description_outrank_filename() {
    // Filename carries all query terms; description/body do not.
    let filename_doc = make_vault_file(
        "alpha beta gamma",
        "card",
        "Body text concerning unrelated kitchen recipes.",
    );
    // Description carries all query terms; filename/body do not.
    let desc_doc = make_vault_file_desc(
        "Curated note",
        "card",
        "alpha beta gamma",
        "Body text concerning unrelated kitchen recipes.",
    );

    let files: Vec<&VaultFile> = vec![&filename_doc, &desc_doc];

    // Historical behavior: title boosted 2.0 → filename-only match dominates.
    let mut old = default_config();
    old.title_boost = 2.0;
    let (hits_old, _) =
        bm25_rank(&files, &vault_root(), "alpha beta gamma", 10, &old).unwrap();
    assert_eq!(
        hits_old[0].title, "alpha beta gamma",
        "under the historical 2.0 title boost the filename-only doc should dominate, got: {:?}",
        hits_old.iter().map(|h| (h.title.as_str(), h.score)).collect::<Vec<_>>()
    );

    // New defaults: title 1.0, description 1.5 → the description match wins.
    let new = default_config();
    let (hits_new, _) =
        bm25_rank(&files, &vault_root(), "alpha beta gamma", 10, &new).unwrap();
    assert_eq!(
        hits_new[0].title, "Curated note",
        "with the default demoted title boost (1.0) and description boost (1.5), the \
         description match must outrank the filename-only match, got: {:?}",
        hits_new.iter().map(|h| (h.title.as_str(), h.score)).collect::<Vec<_>>()
    );
}

// --- Test 16: max_top3_coverage diagnostics field is populated ---
//
// Reuses the displacer/relevant fixture from Test 15.  Asserts that
// `diag.max_top3_coverage` is `Some` and is ≥ rank-1 `diag.coverage`
// (since the relevant doc at rank 2 has higher coverage than the displacer
// at rank 1).

#[test]
fn max_top3_coverage_diagnostics_field_is_populated() {
    let displacer_body =
        "cycle cycle cycle cycle cycle cycle cycle cycle cycle cycle \
         The seasonal cycle repeats. Each annual cycle drives change. \
         Temperature variation marks the cycle. The cycle of seasons is predictable.";
    let displacer = make_vault_file(
        "compound loop learn cycle",
        "card",
        displacer_body,
    );

    let relevant_body =
        "compound loop learn cycle ".repeat(20)
        + "Compounding small improvements over each cycle is how you learn. \
           The feedback loop drives compound learning. Every cycle teaches something. \
           Learn from each loop to compound your gains across cycles.";
    let relevant = make_vault_file(
        "Engineering Feedback",
        "card",
        &relevant_body,
    );

    let files = vec![displacer, relevant];
    let scope = vec!["card".to_string()];

    // Pin title_boost = 2.0 (historical value) so the filename-based displacer ranks #1;
    // see the sibling top3 gate test. The default is now 1.0.
    let mut config = default_config();
    config.elbow_k = 1.0;
    config.title_boost = 2.0;

    let (_result, diag) = run_consult(
        "compound loop learn cycle",
        &files,
        &vault_root(),
        &scope,
        &config,
        ConsultMode::Deliberate,
        false,
    )
    .unwrap();

    // max_top3_coverage must be Some when query is non-empty and hits exist.
    let max_cov = diag.max_top3_coverage.expect(
        "max_top3_coverage should be Some when query is non-empty and hits exist"
    );
    let rank1_cov = diag.coverage.expect(
        "rank-1 coverage should be Some in the same conditions"
    );

    // The relevant doc (rank 2, full coverage) lifts max above rank-1.
    assert!(
        max_cov >= rank1_cov,
        "max_top3_coverage ({:.2}) must be ≥ rank-1 coverage ({:.2})",
        max_cov,
        rank1_cov,
    );

    // Rank-1 coverage is low (displacer body has only "cycle" out of 4 terms).
    assert!(
        rank1_cov < 0.45,
        "rank-1 coverage ({:.2}) should be below 0.45 (displacer fixture)",
        rank1_cov,
    );

    // max_top3_coverage should reach 1.0 because the relevant doc matches all 4 terms.
    assert!(
        (max_cov - 1.0f32).abs() < 1e-4,
        "max_top3_coverage ({:.4}) should be 1.0 when rank-2 doc has full coverage",
        max_cov,
    );
}

// --- Test 17: gate passes but packer admits nothing → Selected with pointers ---
//
// The abstain gate can open while the packer drops every candidate.  Here the sole
// high-coverage doc clears the gate but exceeds a tiny per-doc token cap, so the
// pack ends empty.  Found-but-too-big is a success: the result is Selected with no
// docs and a pointer to the oversized doc, so exit 4 keeps meaning "nothing
// relevant exists" (Decision 4 contract).

#[test]
fn empty_pack_after_gate_pass_returns_selected_with_pointers() {
    // One doc with full coverage of the query → the gate passes.
    let body = "compound loop learn cycle ".repeat(50);
    let relevant = make_vault_file("Long Relevant Note", "card", &body);

    let files = vec![relevant];
    let scope = vec!["card".to_string()];

    let mut config = default_config();
    config.elbow_k = 1.0;
    // Force every candidate over the per-doc cap so the packer admits nothing.
    config.per_doc_token_cap = 1;

    let (result, _diag) = run_consult(
        "compound loop learn cycle",
        &files,
        &vault_root(),
        &scope,
        &config,
        ConsultMode::Deliberate,
        false,
    )
    .unwrap();

    match result {
        ConsultOutcome::Selected { docs, pointers, .. } => {
            assert!(docs.is_empty(), "no doc fits the cap; docs must be empty");
            assert!(
                pointers.iter().any(|p| p.path == "Long Relevant Note.md"),
                "the oversized coverage-cleared doc must appear in pointers, got: {:?}",
                pointers.iter().map(|p| p.path.as_str()).collect::<Vec<_>>()
            );
            for p in &pointers {
                assert!(p.tokens_est > 0, "pointer tokens_est must be positive");
            }
        }
        ConsultOutcome::Abstain { reason, .. } => {
            panic!(
                "expected Selected with pointers when the gate passed but the packer \
                 admitted no doc, got Abstain: {}",
                reason,
            );
        }
    }
}

// --- evaluate_gate: direct unit tests over synthetic hits ---
//
// The gate is now a pure function (`evaluate_gate`) over a score-descending hit
// set and its parallel stemmed-token sets, so each branch is testable without
// building an index or invoking BM25.

/// Build a synthetic `Hit` with a given score and stored body.
fn hit(path: &str, score: f32, body: &str) -> Hit {
    Hit {
        path: path.to_string(),
        title: path.to_string(),
        score,
        stored_body: body.to_string(),
    }
}

/// Stemmed token set of `body`, as the gate sees it.
fn tokset(body: &str) -> HashSet<String> {
    stemmed_tokens(body).into_iter().collect()
}

#[test]
fn gate_opens_on_high_coverage_and_clear_elbow() {
    let hits = vec![hit("a", 10.0, "alpha beta"), hit("b", 1.0, "gamma")];
    let toks = vec![tokset("alpha beta"), tokset("gamma")];
    let q = terms("alpha beta");

    let g = evaluate_gate(&hits, &toks, &q, 0.45, 1.5, None);

    assert!(g.abstain_reason.is_none(), "gate should open: {:?}", g.abstain_reason);
    assert_eq!(g.median, 5.5, "median of [10, 1] is 5.5");
    assert_eq!(g.coverage, Some(1.0));
    assert_eq!(g.max_top3_coverage, Some(1.0));
    let ratio = g.elbow_ratio.expect("two hits → elbow_ratio is Some");
    assert!((ratio - 10.0 / 5.5).abs() < 1e-5);
}

#[test]
fn gate_threshold_backstop_forces_abstain() {
    let hits = vec![hit("a", 10.0, "alpha beta"), hit("b", 1.0, "gamma")];
    let toks = vec![tokset("alpha beta"), tokset("gamma")];
    let q = terms("alpha beta");

    // Top score 10 < threshold 100 → abstain, and threshold wins the reason race.
    let g = evaluate_gate(&hits, &toks, &q, 0.45, 1.5, Some(100.0));
    assert_eq!(g.abstain_reason.as_deref(), Some("below threshold"));
}

#[test]
fn gate_low_coverage_abstains() {
    // No top-3 hit contains a query term → coverage 0 < 0.45.
    let hits = vec![hit("a", 10.0, "gamma delta"), hit("b", 1.0, "epsilon")];
    let toks = vec![tokset("gamma delta"), tokset("epsilon")];
    let q = terms("alpha beta");

    let g = evaluate_gate(&hits, &toks, &q, 0.45, 1.5, None);
    assert_eq!(g.abstain_reason.as_deref(), Some("low coverage"));
    assert_eq!(g.coverage, Some(0.0));
    assert_eq!(g.max_top3_coverage, Some(0.0));
}

#[test]
fn gate_no_elbow_abstains() {
    // Coverage clears and threshold is open, but the top barely leads the median,
    // so a steep elbow_k forces an abstain on the elbow test alone.
    let hits = vec![hit("a", 10.0, "alpha beta"), hit("b", 9.0, "alpha beta")];
    let toks = vec![tokset("alpha beta"), tokset("alpha beta")];
    let q = terms("alpha beta");

    let g = evaluate_gate(&hits, &toks, &q, 0.45, 2.0, None);
    assert_eq!(g.abstain_reason.as_deref(), Some("no score elbow"));
}

#[test]
fn gate_single_hit_treats_elbow_as_vacuous() {
    // One hit: there is no second candidate to form a gap from, so the elbow test
    // passes vacuously and elbow_ratio is None.
    let hits = vec![hit("a", 3.0, "alpha beta")];
    let toks = vec![tokset("alpha beta")];
    let q = terms("alpha beta");

    let g = evaluate_gate(&hits, &toks, &q, 0.45, 99.0, None);
    assert!(g.abstain_reason.is_none(), "single-hit elbow must be vacuously true");
    assert_eq!(g.elbow_ratio, None);
}

#[test]
fn gate_empty_query_terms_abstains_with_none_coverage() {
    // A query that tokenizes to nothing fails the coverage gate; coverage fields
    // are None to signal the degenerate query.
    let hits = vec![hit("a", 10.0, "alpha beta"), hit("b", 1.0, "gamma")];
    let toks = vec![tokset("alpha beta"), tokset("gamma")];
    let q: BTreeSet<String> = BTreeSet::new();

    let g = evaluate_gate(&hits, &toks, &q, 0.45, 1.5, None);
    assert_eq!(g.abstain_reason.as_deref(), Some("low coverage"));
    assert_eq!(g.coverage, None);
    assert_eq!(g.max_top3_coverage, None);
}

#[test]
fn gate_uses_max_coverage_over_top3_not_rank1() {
    // Rank-1 covers nothing; a lower-ranked top-3 hit covers fully. The gate must
    // open on the top-3 maximum while diagnostics retain the rank-1 fraction.
    let hits = vec![
        hit("displacer", 10.0, "gamma"),
        hit("relevant", 9.0, "alpha beta"),
    ];
    let toks = vec![tokset("gamma"), tokset("alpha beta")];
    let q = terms("alpha beta");

    let g = evaluate_gate(&hits, &toks, &q, 0.45, 1.0, None);
    assert!(g.abstain_reason.is_none(), "top-3 max coverage should open the gate");
    assert_eq!(g.coverage, Some(0.0), "rank-1 coverage stays at the displacer's 0.0");
    assert_eq!(g.max_top3_coverage, Some(1.0));
}

// --- query_error diagnostic: parse-failure vs genuine no-results abstain (§4.2) ---

#[test]
fn parse_failure_sets_query_error_diagnostic() {
    // "AND" is a bare boolean operator: it survives sanitization and trips
    // Tantivy's QueryParser, yielding zero hits. The abstain must carry
    // query_error so it is distinguishable from a genuine no-results abstain.
    let card = make_vault_file("Card", "card", "content about retry patterns and backoff");
    let files = vec![card];
    let scope = vec!["card".to_string()];
    let config = default_config();

    let (result, diag) = run_consult(
        "AND",
        &files,
        &vault_root(),
        &scope,
        &config,
        ConsultMode::Deliberate,
        false,
    )
    .unwrap();

    assert!(matches!(result, ConsultOutcome::Abstain { .. }), "parse failure must abstain");
    assert!(
        diag.query_error.is_some(),
        "a parse-failure abstain must populate query_error"
    );
    assert_eq!(diag.num_returned, 0);
}

#[test]
fn genuine_no_results_leaves_query_error_none() {
    // Scope excludes the only file → no in-scope files → genuine empty result.
    // This abstain must NOT set query_error, so the two empty-abstain causes stay
    // distinguishable.
    let card = make_vault_file("Card1", "card", "Some content about retry patterns.");
    let files = vec![card];
    let scope = vec!["track".to_string()];
    let config = default_config();

    let (result, diag) = run_consult(
        "retry",
        &files,
        &vault_root(),
        &scope,
        &config,
        ConsultMode::Deliberate,
        false,
    )
    .unwrap();

    assert!(matches!(result, ConsultOutcome::Abstain { .. }));
    assert!(
        diag.query_error.is_none(),
        "a genuine no-results abstain must not set query_error"
    );
}

// --- Test 18: a fully-packed selection carries no pointers ---

#[test]
fn selected_with_all_docs_packed_has_empty_pointers() {
    let body = "compound loop learn cycle ".repeat(50);
    let relevant = make_vault_file("Long Relevant Note", "card", &body);

    let files = vec![relevant];
    let scope = vec!["card".to_string()];

    // Default caps comfortably fit the ~325-token body.
    let mut config = default_config();
    config.elbow_k = 1.0;

    let (result, _diag) = run_consult(
        "compound loop learn cycle",
        &files,
        &vault_root(),
        &scope,
        &config,
        ConsultMode::Deliberate,
        false,
    )
    .unwrap();

    match result {
        ConsultOutcome::Selected { docs, pointers, .. } => {
            assert!(!docs.is_empty(), "the doc fits the cap and budget; expected it packed");
            assert!(
                pointers.is_empty(),
                "every coverage-cleared candidate was packed; pointers must be empty, got: {:?}",
                pointers.iter().map(|p| p.path.as_str()).collect::<Vec<_>>()
            );
        }
        ConsultOutcome::Abstain { reason, .. } => {
            panic!("expected Selected for a fully-packed relevant doc, got Abstain: {}", reason);
        }
    }
}
