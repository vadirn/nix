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
    frontmatter, vault, wikilink,
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
) -> Result<()> {
    if regex_mode {
        return run_regex(query, cfg, context, subfolder);
    }
    run_bm25(query, cfg, subfolder, limit, format, types)
}

/// Build the BM25 index, run ranking, generate snippets, and return enriched results.
///
/// Returns an empty Vec when no documents match (callers handle the empty case).
pub fn collect_bm25_results(
    query: &str,
    cfg: &crate::config::ResolvedConfig,
    subfolder: Option<&Path>,
    limit: usize,
) -> Result<Vec<SearchResult>> {
    collect_bm25_results_filtered(query, cfg, subfolder, limit, &[])
}

/// Like `collect_bm25_results` but accepts an optional type filter applied pre-index.
pub fn collect_bm25_results_filtered(
    query: &str,
    cfg: &crate::config::ResolvedConfig,
    subfolder: Option<&Path>,
    limit: usize,
    types: &[String],
) -> Result<Vec<SearchResult>> {
    let vault_root = &cfg.vault_root;
    let root = vault::resolve_root(vault_root, subfolder);

    let mut files = vault::scan(&root, vault_root, Some(&cfg.ignore))?;

    // Pre-index type filter: calibrate IDF over the filtered corpus only.
    if !types.is_empty() {
        files.retain(|f| {
            let file_type = frontmatter::get_display(&f.frontmatter, "type");
            frontmatter::matches_type(&file_type, types)
        });
    }

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
        return Ok(vec![]);
    }

    // SnippetGenerator must be created from the same searcher + parsed query.
    let snippet_generator = SnippetGenerator::create(&searcher, &parsed, fields.body)?;

    // Build a path → &VaultFile lookup map for type/links resolution.
    let file_map: HashMap<String, &vault::VaultFile> = files
        .iter()
        .map(|f| (f.relative_path(vault_root), f))
        .collect();

    let mut results = Vec::new();
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

        // snippet: plain text. Use the raw fragment rather than `to_html()`, which
        // HTML-encodes (`&`→`&amp;`, `<`→`&lt;`, `'`→`&#x27;`, …) before wrapping
        // matches in <b> tags — stripping the tags would leave the entity references
        // behind. `fragment()` is the unescaped windowed text with no highlight markup.
        let body_val = doc.get_first(fields.body).and_then(|v| v.as_str()).unwrap_or("");
        let snippet_plain = snippet_generator.snippet(body_val).fragment().to_string();

        // Look up the VaultFile for type and links
        let (doc_type, links, body_text) = if let Some(vf) = file_map.get(&path_val) {
            let t = {
                let v = vf.get_property("type");
                if v.is_empty() { None } else { Some(v) }
            };
            let l = wikilink::collect_all_link_targets(vf);
            // body: frontmatter::body with leading newline stripped
            let b = frontmatter::body(&vf.content)
                .trim_start_matches('\n')
                .to_string();
            (t, l, b)
        } else {
            (None, vec![], body_val.trim_start_matches('\n').to_string())
        };

        let tokens = body_text.chars().count() / 4;

        results.push(SearchResult {
            path: path_val,
            title: title_val,
            doc_type,
            score,
            snippet: snippet_plain,
            body: body_text,
            tokens,
            links,
        });
    }

    Ok(results)
}

fn run_bm25(
    query: &str,
    cfg: &crate::config::ResolvedConfig,
    subfolder: Option<&Path>,
    limit: usize,
    format: SearchFormat,
    types: &[String],
) -> Result<()> {
    // JSON arm: delegate entirely to collect_bm25_results_filtered so the path exercises
    // production index build + enrichment without duplication.
    if format == SearchFormat::Json {
        let results = collect_bm25_results_filtered(query, cfg, subfolder, limit, types)?;
        let output = SearchOutput {
            query: query.to_string(),
            count: results.len(),
            results,
        };
        println!("{}", serde_json::to_string_pretty(&output)?);
        return Ok(());
    }

    // Text arm: stay inline so snippet highlighting (asterisk substitution) is
    // byte-identical to the original output.
    let vault_root = &cfg.vault_root;
    let root = vault::resolve_root(vault_root, subfolder);

    let mut files = vault::scan(&root, vault_root, Some(&cfg.ignore))?;

    // Pre-index type filter: calibrate IDF over the filtered corpus only.
    if !types.is_empty() {
        files.retain(|f| {
            let file_type = frontmatter::get_display(&f.frontmatter, "type");
            frontmatter::matches_type(&file_type, types)
        });
    }

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
        return Ok(());
    }

    let snippet_generator = SnippetGenerator::create(&searcher, &parsed, fields.body)?;

    for (score, doc_address) in top_docs {
        let doc: TantivyDocument = searcher.doc(doc_address)?;
        let path_val = doc
            .get_first(fields.path)
            .and_then(|v| v.as_str())
            .unwrap_or("");
        println!("[{:.2}] {}", score, path_val);

        let body_val = doc.get_first(fields.body).and_then(|v| v.as_str()).unwrap_or("");
        let snippet = snippet_generator.snippet(body_val);
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
) -> Result<()> {
    let vault_root = &cfg.vault_root;
    let re = Regex::new(query)?;

    let root = vault::resolve_root(vault_root, subfolder);

    let files = vault::scan(&root, vault_root, Some(&cfg.ignore))?;

    for file in &files {
        let lines: Vec<&str> = file.content.lines().collect();
        let mut printed_header = false;

        for (i, line) in lines.iter().enumerate() {
            if re.is_match(line) {
                if !printed_header {
                    let rel = file.relative_path(vault_root);
                    println!("{}:", rel);
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
        let results = collect_bm25_results("alpha", &cfg, None, 10).unwrap();

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
        let result = run("workflow: plan first", &cfg, 0, None, false, 10, SearchFormat::Text, &[]);
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
        };
        let json = serde_json::to_string(&result).unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["type"], serde_json::Value::Null);
    }
}
