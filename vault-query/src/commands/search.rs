use anyhow::Result;
use regex::{Regex, RegexBuilder};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{self, Write};
use std::path::Path;
use tantivy::collector::TopDocs;
use tantivy::query::QueryParser;
use tantivy::schema::*;
use tantivy::SnippetGenerator;

use crate::{
    config::{DEFAULT_DESCRIPTION_BOOST, DEFAULT_TITLE_BOOST},
    frontmatter,
    index::{build_index, sanitize_query},
    output::TextJson,
    vault,
    vault_ignore::VaultIgnore,
    wikilink,
};

/// One result in the JSON envelope.
#[derive(Serialize)]
pub struct SearchResult {
    pub path: String,
    pub title: String,
    #[serde(rename = "type")]
    pub doc_type: Option<String>,
    pub score: f32,
    pub snippet: String,
    pub body: String,
    pub tokens: usize,
    pub links: Vec<String>,
    pub superseded: bool,
}

/// The top-level JSON envelope.
#[derive(Serialize)]
pub struct SearchOutput {
    pub query: String,
    pub count: usize,
    pub results: Vec<SearchResult>,
}

pub fn run(
    query: &str,
    cfg: &crate::config::ResolvedConfig,
    context: usize,
    subfolder: Option<&Path>,
    regex_mode: bool,
    limit: usize,
    format: TextJson,
    types: &[String],
    no_superseded: bool,
) -> Result<()> {
    if regex_mode {
        return run_regex(query, cfg, context, subfolder, types, no_superseded);
    }
    run_bm25(query, cfg, subfolder, limit, format, types, no_superseded)
}

/// Scan the vault rooted at `root` and drop files whose frontmatter `type:` is
/// not in `types`. An empty `types` slice means no filter (all files returned).
fn scan_and_filter(
    root: &Path,
    vault_root: &Path,
    ignore: &VaultIgnore,
    types: &[String],
) -> Result<Vec<vault::VaultFile>> {
    let mut files = vault::scan(root, vault_root, Some(ignore))?;
    if !types.is_empty() {
        files.retain(|f| {
            let file_type = frontmatter::get_display(&f.frontmatter, "type");
            frontmatter::matches_type(&file_type, types)
        });
    }
    Ok(files)
}

/// Shared BM25 plumbing for both `run_bm25` arms: scan + type filter, index
/// build, query parse with the shared boosts, ranking, and snippet generator.
/// `None` when no documents matched. Result shaping stays in the callers,
/// since text and JSON output diverge in snippet rendering.
struct Bm25Hits {
    files: Vec<vault::VaultFile>,
    searcher: tantivy::Searcher,
    fields: crate::index::IndexFields,
    top_docs: Vec<(f32, tantivy::DocAddress)>,
    snippet_generator: SnippetGenerator,
}

fn search_bm25(
    query: &str,
    cfg: &crate::config::ResolvedConfig,
    subfolder: Option<&Path>,
    limit: usize,
    types: &[String],
) -> Result<Option<Bm25Hits>> {
    let vault_root = &cfg.vault_root;
    let root = vault::resolve_root(vault_root, subfolder);

    let files = scan_and_filter(&root, vault_root, &cfg.ignore, types)?;

    // Build the shared BM25 index (schema + bilingual analyzer shared with consult).
    let file_refs: Vec<&vault::VaultFile> = files.iter().collect();
    let (index, fields) = build_index(&file_refs, vault_root)?;

    let reader = index.reader()?;
    let searcher = reader.searcher();

    // Parse query over title + description + body with the shared boosts (filename
    // demoted, curated description favored). Sanitize metacharacters first so that
    // natural-language queries containing `:` or other Tantivy syntax chars
    // (e.g. "structure the workflow: plan first") are treated as plain terms.
    let mut query_parser =
        QueryParser::for_index(&index, vec![fields.title, fields.description, fields.body]);
    query_parser.set_field_boost(fields.title, DEFAULT_TITLE_BOOST);
    query_parser.set_field_boost(fields.description, DEFAULT_DESCRIPTION_BOOST);
    let sanitized = sanitize_query(query);
    let parsed = query_parser.parse_query(&sanitized)?;

    // Use the full candidate set so that filter/downrank steps in callers operate
    // over all matching docs, not just the pre-truncated top-N. This prevents
    // superseded entries from consuming limit slots (--no-superseded) and lets a
    // downranked doc be displaced by a non-superseded doc just outside the raw top-N.
    let full_limit = files.len().max(limit);
    let top_docs = searcher.search(&parsed, &TopDocs::with_limit(full_limit))?;

    if top_docs.is_empty() {
        return Ok(None);
    }

    // SnippetGenerator must be created from the same searcher + parsed query.
    let snippet_generator = SnippetGenerator::create(&searcher, &parsed, fields.body)?;

    Ok(Some(Bm25Hits {
        files,
        searcher,
        fields,
        top_docs,
        snippet_generator,
    }))
}

/// Maximum compiled size (bytes) for a user-supplied regex. Bounds the memory a
/// pathological pattern (e.g. deeply nested bounded repetitions like `a{1000}{1000}`)
/// can demand at compile time, so it fails fast with a clean diagnostic instead of
/// exhausting memory. The `regex` crate matches in linear time, so this guards
/// compilation cost, not match-time backtracking.
const REGEX_SIZE_LIMIT: usize = 1 << 20; // 1 MiB

/// Compile a user-supplied search pattern with a bounded compiled size. A syntax
/// error or a pattern exceeding [`REGEX_SIZE_LIMIT`] becomes a clean diagnostic
/// rather than a raw `regex` error string.
fn compile_search_regex(pattern: &str) -> Result<Regex> {
    RegexBuilder::new(pattern)
        .size_limit(REGEX_SIZE_LIMIT)
        .build()
        .map_err(|e| anyhow::anyhow!("invalid search pattern {pattern:?}: {e}"))
}

/// Run `render` against a locked stdout handle, swallowing a broken-pipe error
/// (downstream closed, e.g. `search … | head`) as a clean stop. `println!` panics
/// on a closed pipe; routing the text/regex arms through this turns that into a
/// graceful exit while still propagating any other IO error.
fn with_stdout<F>(render: F) -> Result<()>
where
    F: FnOnce(&mut io::StdoutLock) -> io::Result<()>,
{
    let mut out = io::stdout().lock();
    match render(&mut out) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::BrokenPipe => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// Apply the epistemic-tier policy to one hit's raw BM25 score. The single home
/// for the downrank decision shared by the JSON, text, and regex output arms.
///
/// Returns `None` when `no_superseded` is set and the hit is bottom-tier
/// (`superseded: true` / `type: checkpoint` / `epistemic_status: superseded`),
/// signaling the caller to drop it. Otherwise returns the graded score
/// (raw × tier multiplier: certified 1.0, provisional 0.6, superseded 0.3) paired
/// with the bottom-tier flag used for the `superseded` label. The regex arm has no
/// score and passes a placeholder, using only the filter decision and the flag.
fn downranked(
    score: f32,
    tier: frontmatter::EpistemicTier,
    no_superseded: bool,
) -> Option<(f32, bool)> {
    let is_sup = tier.is_bottom();
    if no_superseded && is_sup {
        return None;
    }
    Some((score * tier.multiplier(), is_sup))
}

/// One ranked BM25 hit after the single downrank pass, shared by the JSON and text
/// output arms. Snippet rendering differs between arms (plain fragment vs. `<b>`→`*`
/// HTML), so the indexed body is carried as `snippet_source` and each arm runs the
/// shared `SnippetGenerator` over it at render time.
struct RankedHit {
    path: String,
    title: String,
    doc_type: Option<String>,
    score: f32,
    /// Frontmatter body (leading newline stripped): the JSON `body` field + tokens.
    body: String,
    /// Indexed body field: the source the `SnippetGenerator` windows over.
    snippet_source: String,
    links: Vec<String>,
    superseded: bool,
}

/// The single epistemic-downrank pass over the BM25 candidate set. Resolves each
/// retrieved doc against the scanned `VaultFile` set, applies [`downranked`] to
/// filter `--no-superseded` hits and grade the rest, then sorts by adjusted score
/// and truncates to `limit`. A retrieved doc that does not resolve to a scanned
/// file is an error (the index and the scan diverged), not a silently skipped row.
fn rank_hits(
    hits: &Bm25Hits,
    vault_root: &Path,
    limit: usize,
    no_superseded: bool,
) -> Result<Vec<RankedHit>> {
    // Build a path → &VaultFile lookup map for type/links/tier resolution.
    let file_map: HashMap<String, &vault::VaultFile> = hits
        .files
        .iter()
        .map(|f| (f.relative_path(vault_root), f))
        .collect();

    let mut ranked = Vec::new();
    for (raw_score, doc_address) in &hits.top_docs {
        let doc: TantivyDocument = hits.searcher.doc(*doc_address)?;
        let path_val = doc
            .get_first(hits.fields.path)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let title_val = doc
            .get_first(hits.fields.title)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        // snippet: plain text. The raw fragment, not `to_html()`, which HTML-encodes
        // (`&`→`&amp;`, `<`→`&lt;`, …) before wrapping matches in <b> tags.
        let body_val = doc
            .get_first(hits.fields.body)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        // The retrieved doc must resolve to a scanned VaultFile; a miss means the
        // index and the scan diverged, which is a bug rather than a doc to skip.
        let vf = file_map.get(&path_val).ok_or_else(|| {
            anyhow::anyhow!("indexed document {path_val:?} not found in scanned vault files")
        })?;

        let Some((score, is_sup)) = downranked(
            *raw_score,
            frontmatter::epistemic_tier(&vf.frontmatter),
            no_superseded,
        ) else {
            continue;
        };

        let doc_type = {
            let v = vf.get_property("type");
            if v.is_empty() { None } else { Some(v) }
        };
        let links = wikilink::collect_all_link_targets(vf);
        // body: frontmatter::body with leading newline stripped.
        let body = frontmatter::body(&vf.content).trim_start_matches('\n').to_string();

        ranked.push(RankedHit {
            path: path_val,
            title: title_val,
            doc_type,
            score,
            body,
            snippet_source: body_val,
            links,
            superseded: is_sup,
        });
    }

    // Re-sort after score adjustment (Tantivy returns pre-downrank order), then
    // truncate to the caller's requested limit.
    ranked.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    ranked.truncate(limit);
    Ok(ranked)
}

/// Build the BM25 index, run ranking, generate snippets, and return enriched results.
/// Pass an empty `types` slice to return all document types (no filter).
/// When `no_superseded` is true, bottom-tier entries (`superseded: true`,
/// `type: checkpoint`, or `epistemic_status: superseded`) are excluded from results
/// entirely. Otherwise every entry's score is multiplied by its epistemic-tier factor
/// (certified 1.0, provisional 0.6, superseded 0.3) post-retrieval; bottom-tier entries
/// are also labeled `superseded: true`.
///
/// Returns an empty Vec when no documents match (callers handle the empty case).
///
/// Formerly there was a no-filter wrapper `collect_bm25_results` that forwarded to this
/// function with `&[]`. It was removed because its only caller (the test suite) was
/// updated to call this function directly with `&[]`, leaving the wrapper unused.
pub fn collect_bm25_results_filtered(
    query: &str,
    cfg: &crate::config::ResolvedConfig,
    subfolder: Option<&Path>,
    limit: usize,
    types: &[String],
    no_superseded: bool,
) -> Result<Vec<SearchResult>> {
    let Some(hits) = search_bm25(query, cfg, subfolder, limit, types)? else {
        return Ok(vec![]);
    };
    let ranked = rank_hits(&hits, &cfg.vault_root, limit, no_superseded)?;

    // Map the shared ranked list onto the JSON envelope shape. The snippet is the
    // unescaped windowed fragment (no highlight markup); tokens estimate over the body.
    let results = ranked
        .into_iter()
        .map(|hit| {
            let snippet = hits
                .snippet_generator
                .snippet(&hit.snippet_source)
                .fragment()
                .to_string();
            let tokens = crate::tokens::estimate_tokens(&hit.body);
            SearchResult {
                path: hit.path,
                title: hit.title,
                doc_type: hit.doc_type,
                score: hit.score,
                snippet,
                body: hit.body,
                tokens,
                links: hit.links,
                superseded: hit.superseded,
            }
        })
        .collect();

    Ok(results)
}

fn run_bm25(
    query: &str,
    cfg: &crate::config::ResolvedConfig,
    subfolder: Option<&Path>,
    limit: usize,
    format: TextJson,
    types: &[String],
    no_superseded: bool,
) -> Result<()> {
    // Both arms delegate to collect_bm25_results_filtered so downranking and
    // [superseded] labeling are applied uniformly; only snippet rendering differs.
    if format == TextJson::Json {
        let results = collect_bm25_results_filtered(query, cfg, subfolder, limit, types, no_superseded)?;
        let output = SearchOutput {
            query: query.to_string(),
            count: results.len(),
            results,
        };
        println!("{}", serde_json::to_string_pretty(&output)?);
        return Ok(());
    }

    // Text arm: single index build via search_bm25, then the shared rank_hits pass.
    let Some(hits) = search_bm25(query, cfg, subfolder, limit, types)? else {
        return Ok(());
    };
    let ranked = rank_hits(&hits, &cfg.vault_root, limit, no_superseded)?;

    with_stdout(|out| {
        for hit in &ranked {
            let sup_label = if hit.superseded { " [superseded]" } else { "" };
            writeln!(out, "[{:.2}]{} {}", hit.score, sup_label, hit.path)?;

            let snippet = hits.snippet_generator.snippet(&hit.snippet_source);
            let html = snippet.to_html();
            if !html.is_empty() {
                // Convert <b>term</b> to *term* for terminal display.
                let display = html.replace("<b>", "*").replace("</b>", "*");
                for line in display.lines() {
                    writeln!(out, "  {}", line)?;
                }
            }
            writeln!(out)?;
        }
        Ok(())
    })
}

fn run_regex(
    query: &str,
    cfg: &crate::config::ResolvedConfig,
    context: usize,
    subfolder: Option<&Path>,
    types: &[String],
    no_superseded: bool,
) -> Result<()> {
    let vault_root = &cfg.vault_root;
    let re = compile_search_regex(query)?;

    let root = vault::resolve_root(vault_root, subfolder);

    let files = scan_and_filter(&root, vault_root, &cfg.ignore, types)?;

    with_stdout(|out| {
        for file in &files {
            // Regex mode has no scores, so the shared downrank pass is used only for
            // its filter decision and bottom-tier label (the placeholder score is
            // discarded).
            let Some((_, is_sup)) = downranked(
                0.0,
                frontmatter::epistemic_tier(&file.frontmatter),
                no_superseded,
            ) else {
                continue;
            };

            let lines: Vec<&str> = file.content.lines().collect();
            let mut printed_header = false;

            for (i, line) in lines.iter().enumerate() {
                if re.is_match(line) {
                    if !printed_header {
                        let rel = file.relative_path(vault_root);
                        let sup_label = if is_sup { " [superseded]" } else { "" };
                        writeln!(out, "{}{}:", rel, sup_label)?;
                        printed_header = true;
                    }

                    let start = i.saturating_sub(context);
                    let end = (i + context + 1).min(lines.len());

                    for (j, line) in lines.iter().enumerate().take(end).skip(start) {
                        let marker = if j == i { ">" } else { " " };
                        writeln!(out, "{} {:4}: {}", marker, j + 1, line)?;
                    }
                    writeln!(out)?;
                }
            }
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;
    fn make_cfg(vault_root: std::path::PathBuf) -> crate::config::ResolvedConfig {
        let ignore = crate::vault_ignore::load(&vault_root, false).unwrap();
        crate::config::ResolvedConfig {
            vault_root,
            projects_path: None,
            project_path: None,
            log_project_path: crate::config::DEFAULT_LOG_PROJECT_PATH.to_string(),
            lint: None,
            consult: None,
            ignore,
        }
    }

    #[test]
    fn test_search_json_format_valid_json_and_eight_fields() {
        let tmp = tempfile::tempdir().unwrap();
        let vault_root = tmp.path().to_path_buf();

        // Write a fixture file with frontmatter type and a wikilink
        let cards_dir = vault_root.join("20 cards");
        std::fs::create_dir_all(&cards_dir).unwrap();
        std::fs::write(
            cards_dir.join("Alpha note.md"),
            "---\ntype: card\n---\n\nThis note talks about alpha retrieval concepts. See [[Beta note]].\n",
        )
        .unwrap();

        let cfg = make_cfg(vault_root.clone());

        // Call production code directly — no index rebuild, no enrichment duplication.
        let results = collect_bm25_results_filtered("alpha", &cfg, None, 10, &[], false).unwrap();

        assert!(!results.is_empty(), "expected at least one search result");

        let r = &results[0];

        // All 8 fields are present by construction; verify their values.
        assert!(!r.path.is_empty(), "missing field: path");
        assert!(!r.title.is_empty(), "missing field: title");

        // type should be "card" (non-null)
        assert_eq!(r.doc_type.as_deref(), Some("card"));

        // links should contain "Beta note"
        assert!(
            r.links.iter().any(|l| l == "Beta note"),
            "expected 'Beta note' in links: {:?}",
            r.links
        );

        // body should not start with a newline
        assert!(
            !r.body.starts_with('\n'),
            "body should not start with newline, got: {:?}",
            &r.body[..r.body.len().min(20)]
        );

        // tokens ≈ body char count / 4
        assert_eq!(r.tokens, r.body.chars().count() / 4);

        // score is positive
        assert!(r.score > 0.0, "score must be positive, got {}", r.score);

        // snippet field is present (may be empty for short docs, but must exist)
        let _ = &r.snippet;

        // Verify the whole Vec serializes to valid JSON with the expected envelope shape.
        let output = SearchOutput {
            query: "alpha".to_string(),
            count: results.len(),
            results,
        };
        let json_str = serde_json::to_string_pretty(&output).unwrap();
        let parsed_json: serde_json::Value = serde_json::from_str(&json_str).unwrap();

        assert!(parsed_json.get("query").is_some(), "missing field: query");
        assert!(parsed_json.get("count").is_some(), "missing field: count");
        assert!(parsed_json.get("results").is_some(), "missing field: results");

        let results_arr = parsed_json["results"].as_array().unwrap();
        assert!(!results_arr.is_empty(), "results array is empty");

        let first = &results_arr[0];
        for field in &["path", "title", "type", "score", "snippet", "body", "tokens", "links"] {
            assert!(first.get(field).is_some(), "missing field in result: {}", field);
        }
    }

    #[test]
    fn test_search_format_from_str() {
        assert_eq!(TextJson::from_str("text").unwrap(), TextJson::Text);
        assert_eq!(TextJson::from_str("json").unwrap(), TextJson::Json);
        assert_eq!(TextJson::from_str("TEXT").unwrap(), TextJson::Text);
        assert!(TextJson::from_str("xml").is_err());
    }

    #[test]
    fn test_search_colon_query_does_not_return_empty() {
        // A query containing a colon used to cause a Tantivy parse error, which
        // would propagate as an Err or silently return zero results.
        // After sanitization, the query should retrieve the matching doc.
        let tmp = tempfile::tempdir().unwrap();
        let vault_root = tmp.path().to_path_buf();

        let cards_dir = vault_root.join("20 cards");
        std::fs::create_dir_all(&cards_dir).unwrap();
        std::fs::write(
            cards_dir.join("Workflow note.md"),
            "---\ntype: card\n---\n\nA good workflow starts with planning. Structure your work first.\n",
        )
        .unwrap();

        let cfg = make_cfg(vault_root.clone());

        // run() with a colon query must not error and must find the doc.
        // We verify by calling run_bm25 indirectly through run() with text format;
        // redirect stdout is not available in unit tests, so we check it does not panic/error.
        let result = run("workflow: plan first", &cfg, 0, None, false, 10, TextJson::Text, &[], false);
        assert!(result.is_ok(), "colon query must not return an error: {:?}", result.err());
    }

    #[test]
    fn test_search_result_serializes_type_as_null_when_absent() {
        let result = SearchResult {
            path: "some/path.md".to_string(),
            title: "Title".to_string(),
            doc_type: None,
            score: 1.5,
            snippet: "snippet text".to_string(),
            body: "body text".to_string(),
            tokens: 2,
            links: vec![],
            superseded: false,
        };
        let json = serde_json::to_string(&result).unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["type"], serde_json::Value::Null);
    }

    /// A fixture vault with two docs — one `type: card`, one `type: note` — both
    /// containing the term "luminary". With `types: &["card"]` only the card doc
    /// should appear in results.
    #[test]
    fn search_types_filter_excludes_non_matching() {
        let tmp = tempfile::tempdir().unwrap();
        let vault_root = tmp.path().to_path_buf();

        let docs_dir = vault_root.join("docs");
        std::fs::create_dir_all(&docs_dir).unwrap();

        // Both docs contain the search term "luminary" so BM25 would return both
        // if the filter were absent.
        std::fs::write(
            docs_dir.join("Card doc.md"),
            "---\ntype: card\n---\n\nThis luminary card covers retrieval basics.\n",
        )
        .unwrap();
        std::fs::write(
            docs_dir.join("Note doc.md"),
            "---\ntype: note\n---\n\nThis luminary note covers writing basics.\n",
        )
        .unwrap();

        let cfg = make_cfg(vault_root.clone());
        let types_filter = vec!["card".to_string()];
        let results =
            collect_bm25_results_filtered("luminary", &cfg, None, 10, &types_filter, false).unwrap();

        assert!(!results.is_empty(), "expected at least one result for the card doc");
        for r in &results {
            assert_eq!(
                r.doc_type.as_deref(),
                Some("card"),
                "all results must have type=card; got {:?} for {}",
                r.doc_type,
                r.path
            );
        }
    }

    /// Same two-doc fixture; calling with `types: &[]` must return both docs.
    #[test]
    fn search_types_filter_empty_matches_all() {
        let tmp = tempfile::tempdir().unwrap();
        let vault_root = tmp.path().to_path_buf();

        let docs_dir = vault_root.join("docs");
        std::fs::create_dir_all(&docs_dir).unwrap();

        std::fs::write(
            docs_dir.join("Card doc.md"),
            "---\ntype: card\n---\n\nThis luminary card covers retrieval basics.\n",
        )
        .unwrap();
        std::fs::write(
            docs_dir.join("Note doc.md"),
            "---\ntype: note\n---\n\nThis luminary note covers writing basics.\n",
        )
        .unwrap();

        let cfg = make_cfg(vault_root.clone());
        let results = collect_bm25_results_filtered("luminary", &cfg, None, 10, &[], false).unwrap();

        let types_found: std::collections::HashSet<Option<&str>> =
            results.iter().map(|r| r.doc_type.as_deref()).collect();

        assert!(
            types_found.contains(&Some("card")),
            "expected card doc in unfiltered results; got: {:?}",
            types_found
        );
        assert!(
            types_found.contains(&Some("note")),
            "expected note doc in unfiltered results; got: {:?}",
            types_found
        );
    }

    /// Two docs, one `type: card` and one `type: note`, both containing the term
    /// "quasar". The regex path with `--types card` must scan only the card doc,
    /// so the note doc must not appear in the filtered file list produced by
    /// `scan_and_filter` (exercised here directly, since `run_regex` prints to
    /// stdout and is not easily captured in unit tests).
    #[test]
    fn search_regex_respects_types_filter() {
        let tmp = tempfile::tempdir().unwrap();
        let vault_root = tmp.path().to_path_buf();

        let docs_dir = vault_root.join("docs");
        std::fs::create_dir_all(&docs_dir).unwrap();

        std::fs::write(
            docs_dir.join("Card doc.md"),
            "---\ntype: card\n---\n\nThis quasar card shines in the night sky.\n",
        )
        .unwrap();
        std::fs::write(
            docs_dir.join("Note doc.md"),
            "---\ntype: note\n---\n\nThis quasar note also shines in the night sky.\n",
        )
        .unwrap();

        let cfg = make_cfg(vault_root.clone());
        let root = vault::resolve_root(&cfg.vault_root, None);
        let types_filter = vec!["card".to_string()];

        // scan_and_filter is the pre-match gating step used by run_regex.
        let files = scan_and_filter(&root, &cfg.vault_root, &cfg.ignore, &types_filter).unwrap();

        assert!(!files.is_empty(), "expected at least one file after filtering");
        for f in &files {
            let file_type = frontmatter::get_display(&f.frontmatter, "type");
            assert_eq!(
                file_type, "card",
                "regex pre-filter must exclude non-card files; got type={:?} for {}",
                file_type,
                f.relative_path(&cfg.vault_root)
            );
        }

        // Also confirm the full run() path succeeds (output goes to stdout, not captured).
        let result = run("quasar", &cfg, 0, None, true, 10, TextJson::Text, &types_filter, false);
        assert!(result.is_ok(), "run() with --regex --types must not error: {:?}", result.err());
    }

    use frontmatter::EpistemicTier;

    #[test]
    fn downranked_grades_each_tier() {
        // Certified is neutral; provisional and superseded scale by the tier
        // multiplier (0.6 / 0.3). None of these is bottom-filtered here.
        let (cert, cert_sup) = downranked(10.0, EpistemicTier::Certified, false).unwrap();
        assert_eq!(cert, 10.0);
        assert!(!cert_sup);

        let (prov, prov_sup) = downranked(10.0, EpistemicTier::Provisional, false).unwrap();
        assert!((prov - 6.0).abs() < 1e-5, "provisional score: {prov}");
        assert!(!prov_sup);

        let (sup, sup_flag) = downranked(10.0, EpistemicTier::Superseded, false).unwrap();
        assert!((sup - 3.0).abs() < 1e-5, "superseded score: {sup}");
        assert!(sup_flag, "bottom tier must carry the superseded label");
    }

    #[test]
    fn downranked_filters_bottom_tier_under_no_superseded() {
        // With no_superseded, only the bottom tier is dropped; non-bottom tiers pass.
        assert!(downranked(10.0, EpistemicTier::Superseded, true).is_none());

        let (cert, _) = downranked(10.0, EpistemicTier::Certified, true).unwrap();
        assert_eq!(cert, 10.0);
        let (prov, _) = downranked(10.0, EpistemicTier::Provisional, true).unwrap();
        assert!((prov - 6.0).abs() < 1e-5);
    }

    #[test]
    fn compile_search_regex_accepts_ordinary_pattern() {
        let re = compile_search_regex("quasar|pulsar").unwrap();
        assert!(re.is_match("a quasar shines"));
        assert!(!re.is_match("a comet streaks"));
    }

    #[test]
    fn compile_search_regex_rejects_oversized_pattern() {
        // Nested bounded repetitions blow the compiled program past REGEX_SIZE_LIMIT;
        // the user pattern must fail fast with a clean diagnostic rather than
        // exhausting memory at compile time.
        let err = compile_search_regex("a{1000}{1000}").unwrap_err();
        assert!(
            err.to_string().contains("invalid search pattern"),
            "expected a clean diagnostic, got: {err}"
        );
    }
}
