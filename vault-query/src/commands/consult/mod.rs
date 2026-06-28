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
use serde::Serialize;
use tantivy::collector::TopDocs;
use tantivy::query::QueryParser;
use tantivy::schema::*;
use tantivy::tokenizer::TextAnalyzer;

use crate::config::ConsultConfig;
use crate::frontmatter;
use crate::index::{bilingual_analyzer, build_index, sanitize_query};
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
/// Serializes directly into the `consult --format json` envelope.
#[derive(Debug, Clone, Serialize)]
pub struct SelectedDoc {
    pub path: String,
    pub title: String,
    #[serde(rename = "type")]
    pub doc_type: Option<String>,
    pub score: f32,
    pub body: String,
    pub tokens: usize,
    pub links: Vec<String>,
    /// True when this document has `superseded: true` in its frontmatter.
    /// Only populated (and potentially true) when `--include-superseded` is set.
    pub superseded: bool,
}

/// A sub-gate hit reported on ABSTAIN (Decision 16).
/// Serializes directly into the `consult --format json` envelope.
#[derive(Debug, Clone, Serialize)]
pub struct NearMiss {
    pub path: String,
    pub title: String,
    pub score: f32,
    /// Stemmed query terms that appear in this document's indexed text.
    pub matched_terms: Vec<String>,
}

/// A relevant document that cleared the gate and per-doc coverage filter but
/// was dropped by the packer (per-doc cap or budget).  Found-but-too-big is a
/// success: the caller reads the doc itself via the path, so exit 4 keeps
/// meaning "nothing relevant exists".
/// Serializes directly into the `consult --format json` envelope.
#[derive(Debug, Clone, Serialize)]
pub struct DocPointer {
    pub path: String,
    pub title: String,
    #[serde(rename = "type")]
    pub doc_type: Option<String>,
    pub score: f32,
    pub coverage: f32,
    pub tokens_est: usize,
    /// `read` address of the section carrying the most matched terms, so the
    /// caller drills straight into the relevant region instead of the folded
    /// whole. `None` when the body has no sections or no line carries a query
    /// term (the pointer then opens a bare overview).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub section: Option<String>,
}

/// Outcome of a `run_consult` call.
#[derive(Debug)]
pub enum ConsultOutcome {
    /// At least one document cleared both gate tests.
    Selected {
        query: String,
        docs: Vec<SelectedDoc>,
        total_tokens: usize,
        /// Coverage-cleared candidates the packer could not inline.
        pointers: Vec<DocPointer>,
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
    /// Set when the post-sanitization query failed to parse (e.g. a bare boolean
    /// operator like `AND` survives sanitization and trips Tantivy's parser).
    /// An abstain with `query_error: Some` is a parse failure, not a genuine
    /// empty result — the two are otherwise both reported as `reason: "no results"`
    /// and would be indistinguishable (§4.2).
    pub query_error: Option<String>,
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
///
/// Returns the scored hits paired with an optional parse-error message: `Some`
/// when `QueryParser` rejected the sanitized query (the hit set is then empty),
/// `None` otherwise. Surfacing the error lets `run_consult` flag a parse-failure
/// abstain distinctly from a genuine no-results abstain (§4.2).
fn bm25_rank(
    files: &[&VaultFile],
    vault_root: &Path,
    query: &str,
    limit: usize,
    config: &ConsultConfig,
) -> Result<(Vec<Hit>, Option<String>)> {
    if files.is_empty() {
        return Ok((vec![], None));
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

    // QueryParser can still fail on a query that survives sanitization (e.g. a bare
    // boolean operator like `AND`). Return the parser error to the caller rather
    // than swallowing it as an empty result, so the abstain it causes is
    // distinguishable from a genuine no-results abstain (§4.2).
    let parsed = match query_parser.parse_query(&sanitized) {
        Ok(p) => p,
        Err(e) => return Ok((vec![], Some(e.to_string()))),
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

    Ok((hits, None))
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
    // token_stream takes &mut self, so the analyzer chain is reused via a
    // thread-local rather than rebuilt on every call (this runs once per
    // candidate body in the gate and packer).
    thread_local! {
        static ANALYZER: std::cell::RefCell<TextAnalyzer> =
            std::cell::RefCell::new(bilingual_analyzer());
    }
    ANALYZER.with(|analyzer| {
        let mut analyzer = analyzer.borrow_mut();
        let mut stream = analyzer.token_stream(text);
        let mut tokens = Vec::new();
        while stream.advance() {
            let text = stream.token().text.clone();
            if !text.is_empty() {
                tokens.push(text);
            }
        }
        tokens
    })
}

// ---------------------------------------------------------------------------
// Section attribution for pointers
// ---------------------------------------------------------------------------

/// Return the `read` address of the section in `body` that carries the most
/// matched query terms, or `None` when no section qualifies.
///
/// Each body line is owned by the deepest section whose inclusive range
/// contains it (ranges nest, so the greatest `level` among containing ranges is
/// the unique owner). A line's matched-term count is credited to its owner; the
/// owner with the highest total wins, ties broken toward the deeper, then
/// earlier, section so the caller lands as specifically as the matches justify.
/// Returns `None` for an empty query, a section-less body, or a body where no
/// line carries a query term — the pointer then opens a bare overview.
fn best_section_address(body: &str, query_terms: &BTreeSet<String>) -> Option<String> {
    if query_terms.is_empty() {
        return None;
    }
    let ranges = crate::section::section_ranges(body);
    if ranges.is_empty() {
        return None;
    }

    let owner_of = |line: usize| -> Option<&crate::section::SectionRange> {
        ranges
            .iter()
            .filter(|r| r.start <= line && line <= r.end)
            .max_by_key(|r| r.level)
    };

    let mut scores: HashMap<&str, usize> = HashMap::new();
    for (idx, text) in body.lines().enumerate() {
        let matched = stemmed_tokens(text)
            .into_iter()
            .filter(|t| query_terms.contains(t))
            .count();
        if matched == 0 {
            continue;
        }
        if let Some(owner) = owner_of(idx + 1) {
            *scores.entry(owner.address.as_str()).or_insert(0) += matched;
        }
    }

    // Walk ranges (depth-first order) and keep the best by (score, deeper level,
    // earlier start). Iterating `ranges` rather than the map gives level/start
    // for free and a deterministic order independent of map hashing.
    let mut best: Option<(&crate::section::SectionRange, usize)> = None;
    for r in &ranges {
        let score = *scores.get(r.address.as_str()).unwrap_or(&0);
        if score == 0 {
            continue;
        }
        let better = match best {
            None => true,
            Some((br, bscore)) => {
                score > bscore
                    || (score == bscore
                        && (r.level > br.level
                            || (r.level == br.level && r.start < br.start)))
            }
        };
        if better {
            best = Some((r, score));
        }
    }
    best.map(|(r, _)| r.address.clone())
}

// ---------------------------------------------------------------------------
// Median helper
// ---------------------------------------------------------------------------

/// Fraction of `query_terms` present in `doc_tokens` (0.0 for an empty query).
///
/// Shared by the abstain gate and the packer's per-doc coverage filter so the two
/// compute coverage identically over the same stemmed token sets.
fn coverage_fraction_of(query_terms: &BTreeSet<String>, doc_tokens: &HashSet<String>) -> f32 {
    if query_terms.is_empty() {
        return 0.0;
    }
    let matched = query_terms.iter().filter(|t| doc_tokens.contains(*t)).count();
    matched as f32 / query_terms.len() as f32
}

/// Return the frontmatter `type` of `file`, or `None` when it is absent/empty.
///
/// `get_property` yields an empty string for a missing `type`; collapsing that to
/// `None` keeps `SelectedDoc.doc_type` / `DocPointer.doc_type` free of empty-string
/// noise in the JSON envelope.
fn frontmatter_doc_type(file: &VaultFile) -> Option<String> {
    let v = file.get_property("type");
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
}

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
/// `top3_tokens` carries the pre-computed stemmed token set per hit (parallel
/// to `hits`, at most 3 entries), so the bodies are not re-tokenized here.
/// `query_terms` is a `BTreeSet`, so `matched_terms` comes out in a stable
/// (sorted) order across invocations — the abstain markdown/JSON is byte-identical
/// for identical inputs.
fn build_near_misses(
    hits: &[Hit],
    query_terms: &BTreeSet<String>,
    top3_tokens: &[HashSet<String>],
) -> Vec<NearMiss> {
    hits.iter()
        .zip(top3_tokens)
        .map(|(h, doc_tokens)| {
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
// Abstain gate (pure stage)
// ---------------------------------------------------------------------------

/// Outcome of the relative abstain gate over a non-empty, tier-scaled,
/// score-descending hit set (Decision 12). Pure function of its inputs — the
/// unit-test seam for the coverage/elbow/threshold math, decoupled from BM25 and
/// the packer.
#[derive(Debug, Clone)]
struct GateEval {
    /// `Some(reason)` when the gate forces an abstain; `None` when it opens.
    abstain_reason: Option<String>,
    /// Median score across all hits — the packer's above-median candidate cut.
    median: f32,
    /// Rank-1 coverage fraction (diagnostics only; the gate uses `max_top3_coverage`).
    coverage: Option<f32>,
    /// Maximum coverage over the top-3 elbow window — the value the coverage gate
    /// decides on (Decision 27).
    max_top3_coverage: Option<f32>,
    /// `top_score / median`, `None` when ≤1 hit or the median is zero.
    elbow_ratio: Option<f32>,
}

/// Apply the relative abstain gate (Decision 12) to a non-empty hit set.
///
/// `hits` must be score-descending and non-empty; `hit_tokens` carries the
/// per-hit stemmed body token sets, parallel to `hits` (computed once by the
/// caller — Step C). The gate combines three tests:
///   - coverage: pass when ANY of the top-3 highest-scoring candidates reaches
///     coverage ≥ `coverage_fraction` (the packer emits a set, so judging only
///     rank 1 would let a high-score/low-coverage doc block a relevant rank-2 doc);
///   - elbow: `top.score >= elbow_k * median` (vacuously true for a single hit);
///   - threshold backstop: `top.score >= threshold` when one is configured.
fn evaluate_gate(
    hits: &[Hit],
    hit_tokens: &[HashSet<String>],
    query_terms: &BTreeSet<String>,
    coverage_fraction: f32,
    elbow_k: f32,
    threshold: Option<f32>,
) -> GateEval {
    let top = &hits[0];
    let scores: Vec<f32> = hits.iter().map(|h| h.score).collect();
    let med = median_f32(&scores);

    let (coverage_ok, coverage_value, max_top3_coverage_value) = if query_terms.is_empty() {
        // Degenerate: query tokenizes to nothing (all special chars). Abstain.
        (false, None, None)
    } else {
        let top3_coverages: Vec<f32> = hit_tokens
            .iter()
            .take(3)
            .map(|t| coverage_fraction_of(query_terms, t))
            .collect();
        // Rank-1 coverage retained for diagnostics; the gate uses the top-3 maximum.
        let top1_frac = top3_coverages[0];
        let max_coverage = top3_coverages.iter().copied().fold(0.0f32, f32::max);
        (max_coverage >= coverage_fraction, Some(top1_frac), Some(max_coverage))
    };

    let elbow_ok = if hits.len() == 1 {
        // Single result: no set to compare against; the elbow test is vacuously true.
        true
    } else {
        top.score >= elbow_k * med
    };

    // Backstop: if a threshold is set and the top score is below it, force abstain.
    let threshold_ok = match threshold {
        Some(t) => top.score >= t,
        None => true,
    };

    let elbow_ratio = if hits.len() > 1 && med > 0.0 {
        Some(top.score / med)
    } else {
        None
    };

    // Reason priority mirrors the original combined check: threshold, then
    // coverage, then elbow.
    let abstain_reason = if !threshold_ok {
        Some("below threshold".to_string())
    } else if !coverage_ok {
        Some("low coverage".to_string())
    } else if !elbow_ok {
        Some("no score elbow".to_string())
    } else {
        None
    };

    GateEval {
        abstain_reason,
        median: med,
        coverage: coverage_value,
        max_top3_coverage: max_top3_coverage_value,
        elbow_ratio,
    }
}

// ---------------------------------------------------------------------------
// Greedy budget packing + pointer assembly (pure stage)
// ---------------------------------------------------------------------------

/// Greedy whole-body budget packing (Decision 15) plus pointer assembly.
///
/// Runs only after the gate opens. `hit_tokens` is parallel to `hits` and carries
/// the per-hit stemmed body tokens computed once by the caller (Step C); the
/// per-doc coverage filter reads them rather than re-tokenizing. Returns the
/// packed docs, their summed token estimate, and the pointers for
/// coverage-cleared candidates the packer dropped (per-doc cap or budget).
fn pack_candidates(
    hits: &[Hit],
    hit_tokens: &[HashSet<String>],
    query_terms: &BTreeSet<String>,
    median: f32,
    coverage_fraction: f32,
    file_map: &HashMap<String, &VaultFile>,
    config: &ConsultConfig,
) -> (Vec<SelectedDoc>, usize, Vec<DocPointer>) {
    // Candidate set: hits with score >= median (above-median set), each paired
    // with its per-doc coverage computed once from the shared token set.
    // PROVISIONAL membership rule: above-median score cut. Tunable in Step F.
    let candidates: Vec<(&Hit, f32)> = hits
        .iter()
        .zip(hit_tokens)
        .filter(|(h, _)| h.score >= median)
        .map(|(h, tokens)| (h, coverage_fraction_of(query_terms, tokens)))
        .collect();

    // Per-doc coverage filter: keep only candidates clearing coverage_fraction.
    // This prevents a high-score / low-coverage "displacer" from consuming token
    // budget at the expense of genuinely relevant docs.
    //
    // `query_terms` is non-empty here — an empty token set fails the coverage gate
    // and abstains before packing.
    //
    // Safety: the gate verified that at least one of the top-3 hits clears
    // coverage_fraction, but that hit may be below the median and absent from
    // `candidates`. If the filter empties the candidate set, fall back to the
    // top-3 hits that clear coverage so the result is never empty.
    let coverage_filtered: Vec<(&Hit, f32)> = {
        let filtered: Vec<(&Hit, f32)> = candidates
            .iter()
            .copied()
            .filter(|(_, cov)| *cov >= coverage_fraction)
            .collect();
        if filtered.is_empty() {
            // The gate opened via a top-3 hit that clears coverage but sits below the
            // median, so it is absent from `candidates`. Pack that hit — it is exactly
            // what justified the gate pass — instead of reverting to the low-coverage
            // above-median displacer the per-doc filter just rejected (bug_004). The
            // gate guarantees at least one such top-3 hit exists, so this is non-empty.
            hits.iter()
                .zip(hit_tokens)
                .take(3)
                .map(|(h, tokens)| (h, coverage_fraction_of(query_terms, tokens)))
                .filter(|(_, cov)| *cov >= coverage_fraction)
                .collect()
        } else {
            filtered
        }
    };

    let mut packed: Vec<SelectedDoc> = Vec::new();
    let mut running_tokens: usize = 0;

    for (hit, _) in &coverage_filtered {
        // Canonical body: the index already stored `frontmatter::body(content)`,
        // so reuse it (leading newline removed) rather than rescanning the file.
        let body = hit.stored_body.trim_start_matches('\n').to_string();

        // Resolve type, links, and superseded flag from the full VaultFile when available.
        let (doc_type, links, is_superseded_doc) = if let Some(vf) = file_map.get(&hit.path) {
            let sup = frontmatter::epistemic_tier(&vf.frontmatter).is_bottom();
            (frontmatter_doc_type(vf), wikilink::collect_all_link_targets(vf), sup)
        } else {
            (None, vec![], false)
        };

        let tokens = crate::tokens::estimate_tokens(&body);

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
                superseded: is_superseded_doc,
            });
        }
        // else: skip this doc and continue to next candidate.
    }

    // Pointers: coverage-cleared candidates the packer dropped (per-doc cap or
    // budget), as the set difference coverage_filtered − packed by path. The
    // difference is uniform across the normal path and the sub-median fallback
    // because both feed `coverage_filtered`; the displacer suppressed by the
    // per-doc coverage filter (Decision 30) never enters it. Found-but-too-big
    // is a success: an empty pack with pointers returns Selected (exit 0) so
    // the caller can read the doc itself, and exit 4 keeps meaning "nothing
    // relevant exists".
    let packed_paths: HashSet<&str> = packed.iter().map(|d| d.path.as_str()).collect();
    let pointers: Vec<DocPointer> = coverage_filtered
        .iter()
        .filter(|(h, _)| !packed_paths.contains(h.path.as_str()))
        .map(|(h, cov)| DocPointer {
            path: h.path.clone(),
            title: h.title.clone(),
            doc_type: file_map.get(&h.path).and_then(|vf| frontmatter_doc_type(vf)),
            score: h.score,
            coverage: *cov,
            tokens_est: crate::tokens::estimate_tokens(h.stored_body.trim_start_matches('\n')),
            section: best_section_address(&h.stored_body, query_terms),
        })
        .collect();

    (packed, running_tokens, pointers)
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
    include_superseded: bool,
) -> Result<(ConsultOutcome, ConsultDiagnostics)> {
    // --- 1. Scope-before-index (Decision 11 + 13) ---
    //
    // Filter to files whose frontmatter `type` is in scope_types AND whose
    // `template` key is not `true`.  Mirrors the `run_by_type` exclusion in
    // `list.rs`.
    // By default, also exclude entries with `superseded: true` frontmatter and
    // entries with `type: checkpoint` (inherently superseded). Pass
    // `include_superseded = true` to restore them.
    let in_scope: Vec<&VaultFile> = files
        .iter()
        .filter(|f| {
            let file_type = frontmatter::get_display(&f.frontmatter, "type");
            // Bottom tier (superseded:true / checkpoint / epistemic_status:superseded)
            // is excluded by default; one tier check subsumes both legacy signals.
            let is_bottom = frontmatter::epistemic_tier(&f.frontmatter).is_bottom();
            frontmatter::matches_type(&file_type, scope_types)
                && !frontmatter::is_template(&f.frontmatter)
                && (include_superseded || !is_bottom)
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
    let (mut hits, query_error) = bm25_rank(&in_scope, vault_root, query, limit, config)?;

    // Grade by epistemic tier (Decision 18): scale each hit's score by its
    // multiplier so a certified entry outranks a provisional one (and, when
    // `--include-superseded` restores them, a superseded one) on the same query.
    // The downstream gate is *relative* (coverage / median / elbow), so a
    // uniformly-provisional result set scales equally and the gate is unchanged;
    // only a mixed certified/provisional set shifts — exactly the intended
    // downrank. Re-sort so the rest of the function keeps its score-desc invariant.
    for h in &mut hits {
        if let Some(vf) = file_map.get(&h.path) {
            h.score *= frontmatter::epistemic_tier(&vf.frontmatter).multiplier();
        }
    }
    hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));

    if hits.is_empty() {
        // `query_error` distinguishes a parse-failure abstain from a genuine
        // no-results abstain; both surface as `reason: "no results"` (§4.2).
        let diag = ConsultDiagnostics {
            top_score: None,
            median_score: None,
            coverage: None,
            max_top3_coverage: None,
            elbow_ratio: None,
            num_returned: 0,
            query_error,
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

    // Stemmed query terms, and the stemmed body tokens of every hit computed once
    // (Step C): the gate, near-misses, and the packer's per-doc coverage filter
    // all read these instead of re-tokenizing the same bodies.
    let query_terms: BTreeSet<String> = stemmed_tokens(query).into_iter().collect();
    let hit_tokens: Vec<HashSet<String>> = hits
        .iter()
        .map(|h| stemmed_tokens(&h.stored_body).into_iter().collect())
        .collect();

    let gate = evaluate_gate(
        &hits,
        &hit_tokens,
        &query_terms,
        coverage_fraction,
        elbow_k,
        config.threshold,
    );

    let diag = ConsultDiagnostics {
        top_score: Some(hits[0].score),
        median_score: Some(gate.median),
        coverage: gate.coverage,
        max_top3_coverage: gate.max_top3_coverage,
        elbow_ratio: gate.elbow_ratio,
        num_returned: hits.len(),
        query_error,
    };

    if let Some(reason) = gate.abstain_reason {
        // Populate near_misses from the top ~3 hits (Decision 16); their token
        // sets are the leading slice of the shared `hit_tokens`.
        let top3 = &hit_tokens[..hit_tokens.len().min(3)];
        let near_misses = build_near_misses(&hits, &query_terms, top3);

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
    let (docs, total_tokens, pointers) = pack_candidates(
        &hits,
        &hit_tokens,
        &query_terms,
        gate.median,
        coverage_fraction,
        &file_map,
        config,
    );

    Ok((
        ConsultOutcome::Selected {
            query: query.to_string(),
            docs,
            total_tokens,
            pointers,
        },
        diag,
    ))
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------


#[cfg(test)]
mod tests;
