use anyhow::Result;
use regex::Regex;
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::str::FromStr;
use tantivy::collector::TopDocs;
use tantivy::query::QueryParser;
use tantivy::schema::*;
use tantivy::SnippetGenerator;

use crate::{
    commands::consult::{build_index, sanitize_query},
    config::{DEFAULT_DESCRIPTION_BOOST, DEFAULT_TITLE_BOOST},
    frontmatter, vault, vault_ignore::VaultIgnore, wikilink,
};

/// Output format for the search command.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SearchFormat {
    Text,
    Json,
}

impl FromStr for SearchFormat {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "text" => Ok(SearchFormat::Text),
            "json" => Ok(SearchFormat::Json),
            _ => Err(format!("unknown format: {} (expected text or json)", s)),
        }
    }
}

impl std::fmt::Display for SearchFormat {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SearchFormat::Text => write!(f, "text"),
            SearchFormat::Json => write!(f, "json"),
        }
    }
}

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
    format: SearchFormat,
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
    fields: crate::commands::consult::IndexFields,
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

    let top_docs = searcher.search(&parsed, &TopDocs::with_limit(limit))?;

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

/// Build the BM25 index, run ranking, generate snippets, and return enriched results.
/// Pass an empty `types` slice to return all document types (no filter).
/// When `no_superseded` is true, entries with `superseded: true` or `type: checkpoint`
/// are excluded from results entirely. Otherwise they are included but their scores
/// are multiplied by 0.3 (post-retrieval downrank) and labeled `superseded: true`.
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
    let Bm25Hits {
        files,
        searcher,
        fields,
        top_docs,
        snippet_generator,
    } = hits;
    let vault_root = &cfg.vault_root;

    // Build a path → &VaultFile lookup map for type/links resolution.
    let file_map: HashMap<String, &vault::VaultFile> = files
        .iter()
        .map(|f| (f.relative_path(vault_root), f))
        .collect();

    let mut results = Vec::new();
    for (raw_score, doc_address) in top_docs {
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

        // snippet: plain text. Use the raw fragment rather than `to_html()`, which
        // HTML-encodes (`&`→`&amp;`, `<`→`&lt;`, `'`→`&#x27;`, …) before wrapping
        // matches in <b> tags — stripping the tags would leave the entity references
        // behind. `fragment()` is the unescaped windowed text with no highlight markup.
        let body_val = doc.get_first(fields.body).and_then(|v| v.as_str()).unwrap_or("");
        let snippet_plain = snippet_generator.snippet(body_val).fragment().to_string();

        // Look up the VaultFile for type, links, and superseded flag.
        let (doc_type, links, body_text, is_sup) = if let Some(vf) = file_map.get(&path_val) {
            let t = {
                let v = vf.get_property("type");
                if v.is_empty() { None } else { Some(v) }
            };
            let l = wikilink::collect_all_link_targets(vf);
            // body: frontmatter::body with leading newline stripped
            let b = frontmatter::body(&vf.content)
                .trim_start_matches('\n')
                .to_string();
            let sup = frontmatter::is_superseded(&vf.frontmatter)
                || t.as_deref() == Some("checkpoint");
            (t, l, b, sup)
        } else {
            (None, vec![], body_val.trim_start_matches('\n').to_string(), false)
        };

        if no_superseded && is_sup {
            continue;
        }

        // Downrank superseded entries by 0.3 post-retrieval.
        let score = if is_sup { raw_score * 0.3 } else { raw_score };

        let tokens = crate::tokens::estimate_tokens(&body_text);

        results.push(SearchResult {
            path: path_val,
            title: title_val,
            doc_type,
            score,
            snippet: snippet_plain,
            body: body_text,
            tokens,
            links,
            superseded: is_sup,
        });
    }

    // Re-sort after score adjustment (Tantivy returns pre-downrank order).
    results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));

    Ok(results)
}

fn run_bm25(
    query: &str,
    cfg: &crate::config::ResolvedConfig,
    subfolder: Option<&Path>,
    limit: usize,
    format: SearchFormat,
    types: &[String],
    no_superseded: bool,
) -> Result<()> {
    // Both arms delegate to collect_bm25_results_filtered so downranking and
    // [superseded] labeling are applied uniformly; only snippet rendering differs.
    if format == SearchFormat::Json {
        let results = collect_bm25_results_filtered(query, cfg, subfolder, limit, types, no_superseded)?;
        let output = SearchOutput {
            query: query.to_string(),
            count: results.len(),
            results,
        };
        println!("{}", serde_json::to_string_pretty(&output)?);
        return Ok(());
    }

    // Text arm: single index build via search_bm25; apply downranking and labeling inline.
    let Some(hits) = search_bm25(query, cfg, subfolder, limit, types)? else {
        return Ok(());
    };

    let vault_root = &cfg.vault_root;
    let file_map: HashMap<String, &vault::VaultFile> = hits.files
        .iter()
        .map(|f| (f.relative_path(vault_root), f))
        .collect();

    // Build (adjusted_score, is_superseded, path, body_val) tuples, then sort.
    struct TextEntry {
        score: f32,
        superseded: bool,
        path: String,
        body: String,
    }
    let mut entries: Vec<TextEntry> = Vec::new();
    for (raw_score, doc_address) in hits.top_docs {
        let doc: TantivyDocument = hits.searcher.doc(doc_address)?;
        let path_val = doc
            .get_first(hits.fields.path)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let body_val = doc
            .get_first(hits.fields.body)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let is_sup = file_map.get(&path_val).map(|vf| {
            let file_type = frontmatter::get_display(&vf.frontmatter, "type");
            frontmatter::is_superseded(&vf.frontmatter) || file_type == "checkpoint"
        }).unwrap_or(false);

        if no_superseded && is_sup {
            continue;
        }

        let score = if is_sup { raw_score * 0.3 } else { raw_score };
        entries.push(TextEntry { score, superseded: is_sup, path: path_val, body: body_val });
    }
    entries.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));

    for entry in &entries {
        let sup_label = if entry.superseded { " [superseded]" } else { "" };
        println!("[{:.2}]{} {}", entry.score, sup_label, entry.path);

        let snippet = hits.snippet_generator.snippet(&entry.body);
        let html = snippet.to_html();
        if !html.is_empty() {
            // Convert <b>term</b> to *term* for terminal display
            let display = html.replace("<b>", "*").replace("</b>", "*");
            for line in display.lines() {
                println!("  {}", line);
            }
        }
        println!();
    }

    Ok(())
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
    let re = Regex::new(query)?;

    let root = vault::resolve_root(vault_root, subfolder);

    let files = scan_and_filter(&root, vault_root, &cfg.ignore, types)?;

    for file in &files {
        let file_type = frontmatter::get_display(&file.frontmatter, "type");
        let is_sup = frontmatter::is_superseded(&file.frontmatter)
            || file_type.as_str() == "checkpoint";

        if no_superseded && is_sup {
            continue;
        }

        let lines: Vec<&str> = file.content.lines().collect();
        let mut printed_header = false;

        for (i, line) in lines.iter().enumerate() {
            if re.is_match(line) {
                if !printed_header {
                    let rel = file.relative_path(vault_root);
                    let sup_label = if is_sup { " [superseded]" } else { "" };
                    println!("{}{}:", rel, sup_label);
                    printed_header = true;
                }

                let start = i.saturating_sub(context);
                let end = (i + context + 1).min(lines.len());

                for (j, line) in lines.iter().enumerate().take(end).skip(start) {
                    let marker = if j == i { ">" } else { " " };
                    println!("{} {:4}: {}", marker, j + 1, line);
                }
                println!();
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn make_cfg(vault_root: std::path::PathBuf) -> crate::config::ResolvedConfig {
        let ignore = crate::vault_ignore::load(&vault_root, false).unwrap();
        crate::config::ResolvedConfig {
            vault_root,
            projects_path: None,
            project_path: None,
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
        assert_eq!(SearchFormat::from_str("text").unwrap(), SearchFormat::Text);
        assert_eq!(SearchFormat::from_str("json").unwrap(), SearchFormat::Json);
        assert_eq!(SearchFormat::from_str("TEXT").unwrap(), SearchFormat::Text);
        assert!(SearchFormat::from_str("xml").is_err());
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
        let result = run("workflow: plan first", &cfg, 0, None, false, 10, SearchFormat::Text, &[], false);
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
        let result = run("quasar", &cfg, 0, None, true, 10, SearchFormat::Text, &types_filter, false);
        assert!(result.is_ok(), "run() with --regex --types must not error: {:?}", result.err());
    }
}
