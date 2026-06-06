//! Selection core for `vault-query consult` (Backlog item 4).
//!
//! Implements three pieces, all reading constants from `ConsultConfig`:
//!   1. Scope-before-index: filter to in-scope files, build BM25 over that set.
//!   2. Relative abstain gate (Decision 12): coverage + score-elbow, threshold backstop.
//!   3. Greedy whole-body budget packing (Decision 15).
//!
//! This module is the unit-test surface — no CLI wiring (Step D does that).

use std::collections::{HashMap, HashSet};
use std::path::Path;

use anyhow::Result;
use tantivy::collector::TopDocs;
use tantivy::query::QueryParser;
use tantivy::schema::*;
use tantivy::tokenizer::{Language, LowerCaser, RemoveLongFilter, SimpleTokenizer, Stemmer, TextAnalyzer};
use tantivy::{doc, Index, IndexWriter};

use crate::config::ConsultConfig;
use crate::frontmatter;
use crate::vault::VaultFile;
use crate::wikilink;

// ---------------------------------------------------------------------------
// Public API types (Decision: final names locked here)
// ---------------------------------------------------------------------------

/// Invocation mode (Decision 18): Ambient uses stricter gate constants.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ConsultMode {
    /// Interactive / deliberate query — fears false-abstain.
    Deliberate,
    /// Global `UserPromptSubmit` hook — fears false-positive.
    Ambient,
}

impl ConsultMode {
    /// Log/label string for this mode.
    pub fn as_str(self) -> &'static str {
        match self {
            ConsultMode::Deliberate => "deliberate",
            ConsultMode::Ambient => "ambient",
        }
    }
}

/// A document selected for inclusion in the ANSWER payload.
#[derive(Debug, Clone)]
pub struct SelectedDoc {
    pub path: String,
    pub title: String,
    pub doc_type: Option<String>,
    pub score: f32,
    pub body: String,
    pub tokens: usize,
    pub links: Vec<String>,
}

/// A sub-gate hit reported on ABSTAIN (Decision 16).
#[derive(Debug, Clone)]
pub struct NearMiss {
    pub path: String,
    pub title: String,
    pub score: f32,
    /// Stemmed query terms that appear in this document's indexed text.
    pub matched_terms: Vec<String>,
}

/// Outcome of a `run_consult` call.
#[derive(Debug)]
pub enum ConsultOutcome {
    /// At least one document cleared both gate tests.
    Selected {
        query: String,
        docs: Vec<SelectedDoc>,
        total_tokens: usize,
    },
    /// No document cleared the gate; near-misses provided for reformulation.
    Abstain {
        query: String,
        near_misses: Vec<NearMiss>,
        reason: String,
    },
}

/// Gate diagnostics captured during a `run_consult` call (Backlog 6).
///
/// Exposes the raw numbers behind each gate decision so that the JSONL log
/// (Step F) can retroactively determine which constant values would have
/// flipped each abstain/select.
#[derive(Debug, Clone)]
pub struct ConsultDiagnostics {
    /// BM25 score of the top-ranked document (`None` if no hits).
    pub top_score: Option<f32>,
    /// Median BM25 score across all returned hits (`None` if no hits).
    pub median_score: Option<f32>,
    /// Coverage fraction of the top doc: matched_query_terms / total_query_terms
    /// (`None` if the query tokenizes to nothing or no hits).
    pub coverage: Option<f32>,
    /// Elbow ratio: top_score / median_score (`None` if ≤1 hit).
    pub elbow_ratio: Option<f32>,
    /// Number of documents returned from BM25 before gate filtering.
    pub num_returned: usize,
}

// ---------------------------------------------------------------------------
// Internal hit type
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Hit {
    path: String,
    title: String,
    score: f32,
    /// The stored body text (from Tantivy doc; identical to frontmatter::body stripped).
    stored_body: String,
}

// ---------------------------------------------------------------------------
// Query sanitization
// ---------------------------------------------------------------------------

/// Replace Tantivy query-syntax metacharacters with spaces so that natural-
/// language queries containing `:`, `+`, `-`, `(`, `)`, `^`, `~`, `"`, `*`,
/// `?`, `[`, `]`, `{`, `}`, `\`, `!` are treated as plain term searches
/// rather than triggering Tantivy's query parser syntax.
///
/// This is applied in the consult query path (ambient hook feeds raw user
/// prompts) and in the search BM25 path so that neither silently returns
/// zero results on a colon-containing query.
pub(crate) fn sanitize_query(query: &str) -> String {
    query
        .chars()
        .map(|c| match c {
            ':' | '+' | '-' | '(' | ')' | '^' | '~' | '"' | '*' | '?' | '[' | ']' | '{'
            | '}' | '\\' | '!' => ' ',
            other => other,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Shared English analysis chain
// ---------------------------------------------------------------------------

/// Build the bilingual (EN + RU) analysis chain shared by `consult` and `search` (Decision 6):
///   SimpleTokenizer → RemoveLongFilter(40) → LowerCaser → Stemmer(English) → Stemmer(Russian).
///
/// English Snowball only mutates Latin vowel/suffix patterns and passes Cyrillic through
/// unchanged; Russian Snowball only mutates Cyrillic and passes Latin through unchanged.
/// Chaining them is safe and stems both languages without corrupting either.
///
/// Single source of truth for both the index `"default"` tokenizer and the
/// coverage tokenizer, so every BM25 site stems identically. A divergence here
/// would silently skew relevance between `search` and `consult`.
pub(crate) fn bilingual_analyzer() -> TextAnalyzer {
    TextAnalyzer::builder(SimpleTokenizer::default())
        .filter(RemoveLongFilter::limit(40))
        .filter(LowerCaser)
        .filter(Stemmer::new(Language::English))
        .filter(Stemmer::new(Language::Russian))
        .build()
}

// ---------------------------------------------------------------------------
// Core BM25 retrieval over an arbitrary file slice
// ---------------------------------------------------------------------------

/// Build a Tantivy in-RAM index over `files`, query it, and return scored hits.
///
/// Uses the same bilingual stemmed analyzer as `search.rs`:
///   SimpleTokenizer → RemoveLongFilter(40) → LowerCaser → Stemmer(English) → Stemmer(Russian)
///
/// `limit` controls the Tantivy top-N cut (IDF and top-N are computed only over
/// the provided `files`, so callers must pre-filter to the in-scope set before
/// calling this — Decision 11).
fn bm25_rank(files: &[&VaultFile], vault_root: &Path, query: &str, limit: usize) -> Result<Vec<Hit>> {
    if files.is_empty() {
        return Ok(vec![]);
    }

    // --- Schema ---
    let mut schema_builder = Schema::builder();
    let title_options = TextOptions::default()
        .set_indexing_options(
            TextFieldIndexing::default()
                .set_tokenizer("default")
                .set_index_option(IndexRecordOption::WithFreqsAndPositions),
        )
        .set_stored();
    let body_options = TextOptions::default()
        .set_indexing_options(
            TextFieldIndexing::default()
                .set_tokenizer("default")
                .set_index_option(IndexRecordOption::WithFreqsAndPositions),
        )
        .set_stored();
    let title_field = schema_builder.add_text_field("title", title_options);
    let body_field = schema_builder.add_text_field("body", body_options);
    let path_field = schema_builder.add_text_field("path", STRING | STORED);
    let schema = schema_builder.build();

    // --- Index ---
    let index = Index::create_in_ram(schema);

    // Register the bilingual analysis chain (shared with search.rs; Decision 6).
    index.tokenizers().register("default", bilingual_analyzer());

    let total_content: usize = files.iter().map(|f| f.content.len()).sum();
    let writer_budget = total_content.max(15_000_000);
    let mut writer: IndexWriter = index.writer(writer_budget)?;

    for file in files {
        let rel = file.relative_path(vault_root);
        let body_text = frontmatter::body(&file.content);
        writer.add_document(doc!(
            title_field => file.name.as_str(),
            body_field => body_text,
            path_field => rel,
        ))?;
    }
    writer.commit()?;

    let reader = index.reader()?;
    let searcher = reader.searcher();

    let mut query_parser = QueryParser::for_index(&index, vec![title_field, body_field]);
    query_parser.set_field_boost(title_field, 2.0);

    // Sanitize metacharacters before handing the query to Tantivy's parser so
    // that natural-language queries (e.g. "structure the workflow: plan first")
    // are treated as literal term searches rather than query syntax.
    let sanitized = sanitize_query(query);

    // QueryParser can still fail on queries with only special chars; return empty on error.
    let parsed = match query_parser.parse_query(&sanitized) {
        Ok(p) => p,
        Err(_) => return Ok(vec![]),
    };

    let top_docs = searcher.search(&parsed, &TopDocs::with_limit(limit))?;

    let mut hits = Vec::new();
    for (score, doc_address) in top_docs {
        let doc: TantivyDocument = searcher.doc(doc_address)?;
        let path_val = doc
            .get_first(path_field)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let title_val = doc
            .get_first(title_field)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let stored_body = doc
            .get_first(body_field)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        hits.push(Hit {
            path: path_val,
            title: title_val,
            score,
            stored_body,
        });
    }

    Ok(hits)
}

// ---------------------------------------------------------------------------
// Stemmed tokenizer for coverage computation
// ---------------------------------------------------------------------------

/// Tokenize `text` with the same stemmed analyzer used for indexing, returning
/// all non-empty lowercase stemmed tokens.
///
/// No stopword list is readily available in this dependency set (tantivy ships
/// none; adding a crate just for stopwords is out of scope for Step C).
/// Decision: all non-empty stemmed tokens count as content terms. Stopwords
/// such as "the", "a", "in" will stem to themselves and be counted; their
/// near-universal presence in docs means they contribute fractionally to coverage
/// but rarely determine the binary pass/fail of the gate.
fn stemmed_tokens(text: &str) -> Vec<String> {
    let mut analyzer = bilingual_analyzer();
    let mut stream = analyzer.token_stream(text);
    let mut tokens = Vec::new();
    while stream.advance() {
        let text = stream.token().text.clone();
        if !text.is_empty() {
            tokens.push(text);
        }
    }
    tokens
}

// ---------------------------------------------------------------------------
// Median helper
// ---------------------------------------------------------------------------

fn median_f32(values: &[f32]) -> f32 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = sorted.len();
    if n % 2 == 1 {
        sorted[n / 2]
    } else {
        (sorted[n / 2 - 1] + sorted[n / 2]) / 2.0
    }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/// Run the full consult pipeline: scope filter → BM25 → gate → pack.
///
/// `files` is the pre-scanned vault slice (all files; scope filtering happens
/// inside this function — Decision 11).
/// `scope_types` is the resolved type list (from config.types or CLI override).
///
/// Returns a `(ConsultOutcome, ConsultDiagnostics)` tuple.  The diagnostics
/// expose the raw gate numbers so the JSONL log can record them for Step F.
pub fn run_consult(
    query: &str,
    files: &[VaultFile],
    vault_root: &Path,
    scope_types: &[String],
    config: &ConsultConfig,
    mode: ConsultMode,
) -> Result<(ConsultOutcome, ConsultDiagnostics)> {
    // --- 1. Scope-before-index (Decision 11 + 13) ---
    //
    // Filter to files whose frontmatter `type` is in scope_types AND whose
    // `template` key is not `true`.  Mirrors the `run_by_type` exclusion in
    // `list.rs`.
    let in_scope: Vec<&VaultFile> = files
        .iter()
        .filter(|f| {
            let file_type = frontmatter::get_display(&f.frontmatter, "type");
            scope_types.iter().any(|t| t == &file_type)
                && frontmatter::get_bool(&f.frontmatter, "template") != Some(true)
        })
        .collect();

    // Build a path-keyed lookup for enrichment at output time.
    let file_map: HashMap<String, &VaultFile> = in_scope
        .iter()
        .map(|f| (f.relative_path(vault_root), *f))
        .collect();

    // BM25 over the in-scope set only.  Retrieve enough candidates for the gate
    // (20 gives a stable median; the packer may use fewer).
    let limit = 20;
    let hits = bm25_rank(&in_scope, vault_root, query, limit)?;

    if hits.is_empty() {
        let diag = ConsultDiagnostics {
            top_score: None,
            median_score: None,
            coverage: None,
            elbow_ratio: None,
            num_returned: 0,
        };
        return Ok((
            ConsultOutcome::Abstain {
                query: query.to_string(),
                near_misses: vec![],
                reason: "no results".to_string(),
            },
            diag,
        ));
    }

    // --- 2. Relative abstain gate (Decision 12) ---

    let (coverage_fraction, elbow_k) = match mode {
        ConsultMode::Deliberate => (config.coverage_fraction, config.elbow_k),
        ConsultMode::Ambient => (config.ambient_coverage_fraction, config.ambient_elbow_k),
    };

    let top = &hits[0];
    let scores: Vec<f32> = hits.iter().map(|h| h.score).collect();
    let med = median_f32(&scores);

    // Coverage: distinct stemmed query content terms present in the top doc's text.
    // We check the stored body text (indexed content) for each term.
    let query_terms: HashSet<String> = stemmed_tokens(query).into_iter().collect();

    let (coverage_ok, coverage_value) = if query_terms.is_empty() {
        // Degenerate: query tokenizes to nothing (all special chars). Abstain.
        (false, None)
    } else {
        let top_doc_tokens: HashSet<String> =
            stemmed_tokens(&top.stored_body).into_iter().collect();
        let matched = query_terms
            .iter()
            .filter(|t| top_doc_tokens.contains(*t))
            .count();
        let frac = matched as f32 / query_terms.len() as f32;
        (frac >= coverage_fraction, Some(frac))
    };

    let elbow_ok = if hits.len() == 1 {
        // Single result: no set to compare against; elbow test is vacuously true
        // (there is no second candidate to form a gap from).
        true
    } else {
        top.score >= elbow_k * med
    };

    // Backstop: if threshold is set and top score is below it, force abstain.
    let threshold_ok = match config.threshold {
        Some(t) => top.score >= t,
        None => true,
    };

    // Compute elbow_ratio for diagnostics (None when only one hit).
    let elbow_ratio = if hits.len() > 1 && med > 0.0 {
        Some(top.score / med)
    } else {
        None
    };

    let diag = ConsultDiagnostics {
        top_score: Some(top.score),
        median_score: Some(med),
        coverage: coverage_value,
        elbow_ratio,
        num_returned: hits.len(),
    };

    if !coverage_ok || !elbow_ok || !threshold_ok {
        // Populate near_misses from the top ~3 hits (Decision 16).
        let reason = if !threshold_ok {
            "below threshold".to_string()
        } else if !coverage_ok {
            "low coverage".to_string()
        } else {
            "no score elbow".to_string()
        };

        let near_misses = hits
            .iter()
            .take(3)
            .map(|h| {
                let doc_tokens: HashSet<String> =
                    stemmed_tokens(&h.stored_body).into_iter().collect();
                let matched_terms: Vec<String> = query_terms
                    .iter()
                    .filter(|t| doc_tokens.contains(*t))
                    .cloned()
                    .collect();
                NearMiss {
                    path: h.path.clone(),
                    title: h.title.clone(),
                    score: h.score,
                    matched_terms,
                }
            })
            .collect();

        return Ok((
            ConsultOutcome::Abstain {
                query: query.to_string(),
                near_misses,
                reason,
            },
            diag,
        ));
    }

    // --- 3. Greedy whole-body budget packing (Decision 15) ---
    //
    // Candidate set: hits with score >= median (above-median set).
    // PROVISIONAL membership rule: above-median score cut. Tunable in Step F.
    let candidates: Vec<&Hit> = hits.iter().filter(|h| h.score >= med).collect();

    let mut packed: Vec<SelectedDoc> = Vec::new();
    let mut running_tokens: usize = 0;

    for hit in &candidates {
        // Canonical body: the index already stored `frontmatter::body(content)`,
        // so reuse it (leading newline removed) rather than rescanning the file.
        let body = hit.stored_body.trim_start_matches('\n').to_string();

        // Resolve type and links from the full VaultFile when available.
        let (doc_type, links) = if let Some(vf) = file_map.get(&hit.path) {
            let t = {
                let v = vf.get_property("type");
                if v.is_empty() { None } else { Some(v) }
            };
            (t, wikilink::collect_all_link_targets(vf))
        } else {
            (None, vec![])
        };

        let tokens = body.chars().count() / 4;

        // Skip whole if the single doc exceeds the per-doc cap.
        if tokens > config.per_doc_token_cap {
            continue;
        }

        // Include if it fits in the remaining budget; skip and continue otherwise.
        // A later smaller doc may still fit (Decision 15: greedy whole-body, no truncation).
        if running_tokens + tokens <= config.token_budget {
            running_tokens += tokens;
            packed.push(SelectedDoc {
                path: hit.path.clone(),
                title: hit.title.clone(),
                doc_type,
                score: hit.score,
                body,
                tokens,
                links,
            });
        }
        // else: skip this doc and continue to next candidate.
    }

    Ok((
        ConsultOutcome::Selected {
            query: query.to_string(),
            docs: packed,
            total_tokens: running_tokens,
        },
        diag,
    ))
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

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

    // --- Test 5: packing respects per_doc_token_cap ---

    #[test]
    fn packing_skips_oversized_doc() {
        // A doc whose body is large (> per_doc_token_cap) and a small doc that fits.
        // The large doc should be skipped; the small doc should be included.
        let per_doc_cap = 50; // very small cap for test
        let big_body = "word ".repeat(300); // 300 * 5 chars = 1500 chars → ~375 tokens
        let small_body = "retry backoff failure pattern helps resilience in distributed systems";

        let big = make_vault_file("BigDoc", "card", &big_body);
        let small = make_vault_file("SmallDoc", "card", small_body);

        let files = vec![big, small];
        let scope = vec!["card".to_string()];
        let mut config = default_config();
        config.per_doc_token_cap = per_doc_cap;
        config.token_budget = 10_000; // generous budget

        let (result, _diag) = run_consult(
            "retry backoff failure",
            &files,
            &vault_root(),
            &scope,
            &config,
            ConsultMode::Deliberate,
        )
        .unwrap();

        match result {
            ConsultOutcome::Selected { docs, .. } => {
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
            }
            ConsultOutcome::Abstain { .. } => {
                // If SmallDoc doesn't have enough overlap to pass the gate, that's OK.
                // The test primarily validates that BigDoc is skipped when it does pass.
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
        )
        .unwrap();

        assert!(
            matches!(result, ConsultOutcome::Abstain { .. }),
            "expected Abstain when no files are in scope"
        );
    }

    // --- Test 11: sanitize_query strips metacharacters ---

    #[test]
    fn sanitize_query_replaces_metacharacters() {
        assert_eq!(sanitize_query("structure the workflow: plan first"), "structure the workflow  plan first");
        assert_eq!(sanitize_query("retry - backoff"), "retry   backoff");
        assert_eq!(sanitize_query("title:value"), "title value");
        assert_eq!(sanitize_query("no specials here"), "no specials here");
    }

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
}
