//! Selection core for `vault-query consult` (Backlog item 4).
//!
//! Implements three pieces, all reading constants from `ConsultConfig`:
//!   1. Scope-before-index: filter to in-scope files, build BM25 over that set.
//!   2. Relative abstain gate (Decision 12): coverage + score-elbow, threshold backstop.
//!   3. Greedy whole-body budget packing (Decision 15).
//!
//! This module is the unit-test surface — no CLI wiring (Step D does that).

use std::collections::{BTreeSet, HashMap, HashSet};
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
    /// Maximum coverage fraction over the top-3 elbow candidates (the value the
    /// Decision 27 gate uses to decide).  `None` when the query tokenizes to
    /// nothing or there are no hits.
    pub max_top3_coverage: Option<f32>,
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
// Shared BM25 index builder (consult + both search sites)
// ---------------------------------------------------------------------------

/// Field handles for the shared BM25 schema, returned by [`build_index`].
///
/// `Field` is `Copy`, so callers freely pass these into the query parser, into a
/// `SnippetGenerator` (search), and into stored-doc readback (consult's coverage gate).
pub(crate) struct IndexFields {
    pub title: Field,
    pub description: Field,
    pub body: Field,
    pub path: Field,
}

/// Build the in-RAM Tantivy index shared by every BM25 site: `consult`'s `bm25_rank`
/// and `search`'s `collect_bm25_results` + `run_bm25` text arm. One definition so the
/// three sites cannot drift in schema or analyzer.
///
/// Schema:
///   - `title`       ← `file.name` (the filename), STORED, default tokenizer
///   - `description` ← frontmatter `description:` precis, INDEX-ONLY (not stored;
///                     nothing reads it back — coverage reads `stored_body`)
///   - `body`        ← `frontmatter::body()`, STORED
///   - `path`        ← relative path, STRING | STORED
///
/// Everything downstream of `commit()` (query-parser boosts, search, snippet
/// generation, result shaping) stays in the caller, since those steps diverge between
/// consult and search. Per-field boosts are set by the caller — from `ConsultConfig`
/// (consult) or `DEFAULT_TITLE_BOOST` / `DEFAULT_DESCRIPTION_BOOST` (search).
pub(crate) fn build_index(files: &[&VaultFile], vault_root: &Path) -> Result<(Index, IndexFields)> {
    let mut schema_builder = Schema::builder();
    let stored_text = || {
        TextOptions::default()
            .set_indexing_options(
                TextFieldIndexing::default()
                    .set_tokenizer("default")
                    .set_index_option(IndexRecordOption::WithFreqsAndPositions),
            )
            .set_stored()
    };
    // description participates in scoring but is never read back, so index-only.
    let indexed_only = TextOptions::default().set_indexing_options(
        TextFieldIndexing::default()
            .set_tokenizer("default")
            .set_index_option(IndexRecordOption::WithFreqsAndPositions),
    );
    let title = schema_builder.add_text_field("title", stored_text());
    let description = schema_builder.add_text_field("description", indexed_only);
    let body = schema_builder.add_text_field("body", stored_text());
    let path = schema_builder.add_text_field("path", STRING | STORED);
    let schema = schema_builder.build();

    let index = Index::create_in_ram(schema);

    // Register the bilingual analysis chain (Decision 6) so every site stems identically.
    index.tokenizers().register("default", bilingual_analyzer());

    let total_content: usize = files.iter().map(|f| f.content.len()).sum();
    let writer_budget = total_content.max(15_000_000);
    let mut writer: IndexWriter = index.writer(writer_budget)?;

    for file in files {
        let rel = file.relative_path(vault_root);
        let body_text = frontmatter::body(&file.content);
        let description_text = frontmatter::get_display(&file.frontmatter, "description");
        writer.add_document(doc!(
            title => file.name.as_str(),
            description => description_text,
            body => body_text,
            path => rel,
        ))?;
    }
    writer.commit()?;

    Ok((
        index,
        IndexFields {
            title,
            description,
            body,
            path,
        },
    ))
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
fn bm25_rank(
    files: &[&VaultFile],
    vault_root: &Path,
    query: &str,
    limit: usize,
    config: &ConsultConfig,
) -> Result<Vec<Hit>> {
    if files.is_empty() {
        return Ok(vec![]);
    }

    // Schema + index build is shared with both search sites (build_index).
    let (index, fields) = build_index(files, vault_root)?;

    let reader = index.reader()?;
    let searcher = reader.searcher();

    // Query over title + description + body. Boosts come from config so consult
    // can be recalibrated without a rebuild: the filename (title) is demoted and
    // the curated `description` precis is favored; body stays at the implicit 1.0.
    let mut query_parser =
        QueryParser::for_index(&index, vec![fields.title, fields.description, fields.body]);
    query_parser.set_field_boost(fields.title, config.title_boost);
    query_parser.set_field_boost(fields.description, config.description_boost);

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
            .get_first(fields.path)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let title_val = doc
            .get_first(fields.title)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        // description is index-only (not stored); the coverage gate reads body.
        let stored_body = doc
            .get_first(fields.body)
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
// Near-miss helper
// ---------------------------------------------------------------------------

/// Build the `near_misses` payload from the top ~3 hits (Decision 16).
///
/// `query_terms` is a `BTreeSet`, so `matched_terms` comes out in a stable
/// (sorted) order across invocations — the abstain markdown/JSON is byte-identical
/// for identical inputs.
fn build_near_misses(hits: &[Hit], query_terms: &BTreeSet<String>) -> Vec<NearMiss> {
    hits.iter()
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
        .collect()
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/// Run the full consult pipeline: scope filter → BM25 → gate → pack.
///
/// `files` is the pre-scanned vault slice (all files; scope filtering happens
/// inside this function — Decision 11).
/// `scope_types` is the resolved type list (from config.types or CLI override).
/// An empty `scope_types` matches all types (pass-through), meaning a config
/// with `types = []` searches the whole vault rather than abstaining. The default
/// config types are non-empty, so this is an edge case in practice.
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
            frontmatter::matches_type(&file_type, scope_types)
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
    let hits = bm25_rank(&in_scope, vault_root, query, limit, config)?;

    if hits.is_empty() {
        let diag = ConsultDiagnostics {
            top_score: None,
            median_score: None,
            coverage: None,
            max_top3_coverage: None,
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

    // Coverage gate: pass when ANY of the top-3 highest-scoring in-scope candidates
    // reaches coverage ≥ coverage_fraction.
    //
    // Rationale: the packer emits a SET of docs but the old gate judged only rank 1.
    // That is a structural mismatch — a high-score/low-coverage doc at rank 1 would
    // block a relevant rank-2 doc from ever being returned.  Taking the maximum
    // coverage over the top-3 inspection window (3 = inspection bound) fixes the
    // defect while leaving the elbow test, median cut, and threshold backstop intact.
    // False-positive safety still rests on the elbow test.
    //
    // Diagnostics retain the rank-1 coverage so existing callers/logs are unaffected;
    // the gate decision uses the top-3 maximum.
    let query_terms: BTreeSet<String> = stemmed_tokens(query).into_iter().collect();

    // Top-3 inspection bound: examine at most the 3 highest-scoring candidates.
    let top3_inspect = hits.iter().take(3);

    let (coverage_ok, coverage_value, max_top3_coverage_value) = if query_terms.is_empty() {
        // Degenerate: query tokenizes to nothing (all special chars). Abstain.
        (false, None, None)
    } else {
        // Rank-1 coverage retained for diagnostics.
        let top_doc_tokens: HashSet<String> =
            stemmed_tokens(&top.stored_body).into_iter().collect();
        let top1_matched = query_terms
            .iter()
            .filter(|t| top_doc_tokens.contains(*t))
            .count();
        let top1_frac = top1_matched as f32 / query_terms.len() as f32;

        // Max coverage over top-3 for the gate decision.
        let max_coverage = top3_inspect
            .map(|h| {
                let doc_tokens: HashSet<String> =
                    stemmed_tokens(&h.stored_body).into_iter().collect();
                let matched = query_terms
                    .iter()
                    .filter(|t| doc_tokens.contains(*t))
                    .count();
                matched as f32 / query_terms.len() as f32
            })
            .fold(0.0f32, f32::max);

        (max_coverage >= coverage_fraction, Some(top1_frac), Some(max_coverage))
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
        max_top3_coverage: max_top3_coverage_value,
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

        let near_misses = build_near_misses(&hits, &query_terms);

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

    // Per-doc coverage filter: compute coverage for each candidate and keep only
    // those that clear coverage_fraction.  This prevents a high-score / low-coverage
    // "displacer" from consuming token budget at the expense of genuinely relevant docs.
    //
    // Safety: the gate verified that at least one of the top-3 hits clears
    // coverage_fraction, but that hit may be below the median and therefore absent from
    // `candidates`.  If the filter empties the candidate set, fall back to all
    // candidates (preserving the pre-filter pack behaviour) so the result is never empty.
    // Per-doc coverage: fraction of query terms present in the doc body.
    let doc_coverage = |h: &Hit| -> f32 {
        if query_terms.is_empty() {
            return 0.0;
        }
        let doc_tokens: HashSet<String> = stemmed_tokens(&h.stored_body).into_iter().collect();
        let matched = query_terms.iter().filter(|t| doc_tokens.contains(*t)).count();
        matched as f32 / query_terms.len() as f32
    };

    let coverage_filtered: Vec<&Hit> = if query_terms.is_empty() {
        // Degenerate query: no terms to compute coverage against; pass all candidates.
        candidates.iter().copied().collect()
    } else {
        let filtered: Vec<&Hit> = candidates
            .iter()
            .copied()
            .filter(|h| doc_coverage(h) >= coverage_fraction)
            .collect();
        if filtered.is_empty() {
            // The gate opened via a top-3 hit that clears coverage but sits below the
            // median, so it is absent from `candidates`.  Pack that hit — it is exactly
            // what justified the gate pass — instead of reverting to the low-coverage
            // above-median displacer the per-doc filter just rejected (bug_004).  The
            // gate guarantees at least one such top-3 hit exists, so this is non-empty.
            hits.iter()
                .take(3)
                .filter(|h| doc_coverage(h) >= coverage_fraction)
                .collect()
        } else {
            filtered
        }
    };

    let mut packed: Vec<SelectedDoc> = Vec::new();
    let mut running_tokens: usize = 0;

    for hit in &coverage_filtered {
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

    // Every coverage-qualified candidate was either over the per-doc cap or too large
    // for the remaining budget, leaving nothing to weave.  Abstain rather than emit a
    // doc-less `Selected`, which would tell the caller (per SKILL.md) to weave context
    // that does not exist and break the exit-code contract — 0 = selected with docs,
    // 4 = abstain (bug_009).
    if packed.is_empty() {
        return Ok((
            ConsultOutcome::Abstain {
                query: query.to_string(),
                near_misses: build_near_misses(&hits, &query_terms),
                reason: "no candidate within token budget".to_string(),
            },
            diag,
        ));
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
            ConsultOutcome::Selected { docs, .. } => {
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
        let hits = bm25_rank(&files, &vault_root(), "photosynthesis chloroplast", 10, &config)
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
        let hits_old =
            bm25_rank(&files, &vault_root(), "alpha beta gamma", 10, &old).unwrap();
        assert_eq!(
            hits_old[0].title, "alpha beta gamma",
            "under the historical 2.0 title boost the filename-only doc should dominate, got: {:?}",
            hits_old.iter().map(|h| (h.title.as_str(), h.score)).collect::<Vec<_>>()
        );

        // New defaults: title 1.0, description 1.5 → the description match wins.
        let new = default_config();
        let hits_new =
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

    // --- Test 17: gate passes but packer admits nothing → Abstain (bug_009) ---
    //
    // The abstain gate can open while the packer drops every candidate.  Here the sole
    // high-coverage doc clears the gate but exceeds a tiny per-doc token cap, so the
    // pack ends empty.  The result must be Abstain, not a doc-less Selected, so the
    // exit-code contract holds: 0 = selected with docs, 4 = abstain.

    #[test]
    fn empty_pack_after_gate_pass_abstains() {
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
        )
        .unwrap();

        match result {
            ConsultOutcome::Abstain { reason, .. } => {
                assert_eq!(reason, "no candidate within token budget");
            }
            ConsultOutcome::Selected { docs, total_tokens, .. } => {
                panic!(
                    "expected Abstain when the packer admits no doc, got Selected with \
                     {} doc(s), {} tokens",
                    docs.len(),
                    total_tokens,
                );
            }
        }
    }
}
