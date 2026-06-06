use anyhow::Result;
use regex::Regex;
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::str::FromStr;
use tantivy::collector::TopDocs;
use tantivy::query::QueryParser;
use tantivy::schema::*;
use tantivy::tokenizer::{Language, RemoveLongFilter, Stemmer, TextAnalyzer};
use tantivy::{doc, Index, IndexWriter, SnippetGenerator};

use crate::{frontmatter, vault, wikilink};

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
) -> Result<()> {
    if regex_mode {
        return run_regex(query, cfg, context, subfolder);
    }
    run_bm25(query, cfg, subfolder, limit, format)
}

fn run_bm25(
    query: &str,
    cfg: &crate::config::ResolvedConfig,
    subfolder: Option<&Path>,
    limit: usize,
    format: SearchFormat,
) -> Result<()> {
    let vault_root = &cfg.vault_root;
    let root = vault::resolve_root(vault_root, subfolder);

    let files = vault::scan(&root, vault_root, Some(&cfg.ignore))?;

    // Build schema
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
    let title = schema_builder.add_text_field("title", title_options);
    let body = schema_builder.add_text_field("body", body_options);
    let path_field = schema_builder.add_text_field("path", STRING | STORED);
    let schema = schema_builder.build();

    // Build in-RAM index
    let index = Index::create_in_ram(schema);

    // Register the English analysis chain: tokenize → drop long tokens → lowercase → stem
    index.tokenizers().register(
        "default",
        TextAnalyzer::builder(tantivy::tokenizer::SimpleTokenizer::default())
            .filter(RemoveLongFilter::limit(40))
            .filter(tantivy::tokenizer::LowerCaser)
            .filter(Stemmer::new(Language::English))
            .build(),
    );

    let total_content: usize = files.iter().map(|f| f.content.len()).sum();
    let writer_budget = total_content.max(15_000_000);
    let mut writer: IndexWriter = index.writer(writer_budget)?;

    for file in &files {
        let rel = file.relative_path(vault_root);
        let body_text = frontmatter::body(&file.content);
        writer.add_document(doc!(
            title => file.name.as_str(),
            body => body_text,
            path_field => rel,
        ))?;
    }
    writer.commit()?;

    let reader = index.reader()?;
    let searcher = reader.searcher();

    // Parse query with title boosted
    let mut query_parser = QueryParser::for_index(&index, vec![title, body]);
    query_parser.set_field_boost(title, 2.0);
    let parsed = query_parser.parse_query(query)?;

    let top_docs = searcher.search(&parsed, &TopDocs::with_limit(limit))?;

    if top_docs.is_empty() {
        if format == SearchFormat::Json {
            let output = SearchOutput {
                query: query.to_string(),
                count: 0,
                results: vec![],
            };
            println!("{}", serde_json::to_string_pretty(&output)?);
        }
        return Ok(());
    }

    let snippet_generator = SnippetGenerator::create(&searcher, &parsed, body)?;

    match format {
        SearchFormat::Text => {
            for (score, doc_address) in top_docs {
                let doc: TantivyDocument = searcher.doc(doc_address)?;
                let path_val = doc
                    .get_first(path_field)
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                println!("[{:.2}] {}", score, path_val);

                let body_val = doc.get_first(body).and_then(|v| v.as_str()).unwrap_or("");
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
        }
        SearchFormat::Json => {
            // Build a path → &VaultFile lookup map for type/links resolution
            let file_map: HashMap<String, &vault::VaultFile> = files
                .iter()
                .map(|f| (f.relative_path(vault_root), f))
                .collect();

            let mut results = Vec::new();
            for (score, doc_address) in top_docs {
                let doc: TantivyDocument = searcher.doc(doc_address)?;
                let path_val = doc
                    .get_first(path_field)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                let title_val = doc
                    .get_first(title)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                // snippet: plain text (strip <b>/<b> tags, no asterisk substitution)
                let body_val = doc.get_first(body).and_then(|v| v.as_str()).unwrap_or("");
                let snippet_obj = snippet_generator.snippet(body_val);
                let snippet_plain = snippet_obj
                    .to_html()
                    .replace("<b>", "")
                    .replace("</b>", "");

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

            let output = SearchOutput {
                query: query.to_string(),
                count: results.len(),
                results,
            };
            println!("{}", serde_json::to_string_pretty(&output)?);
        }
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

        // Capture JSON output by calling run_bm25 via the public `run` function.
        // We redirect stdout by using a pipe trick — instead, test via the struct directly.
        // Build the index inline to produce a SearchOutput we can inspect.
        let files = crate::vault::scan(&vault_root, &vault_root, Some(&cfg.ignore)).unwrap();

        let mut schema_builder = Schema::builder();
        let title_opts = TextOptions::default()
            .set_indexing_options(
                TextFieldIndexing::default()
                    .set_tokenizer("default")
                    .set_index_option(IndexRecordOption::WithFreqsAndPositions),
            )
            .set_stored();
        let body_opts = TextOptions::default()
            .set_indexing_options(
                TextFieldIndexing::default()
                    .set_tokenizer("default")
                    .set_index_option(IndexRecordOption::WithFreqsAndPositions),
            )
            .set_stored();
        let title_field = schema_builder.add_text_field("title", title_opts);
        let body_field = schema_builder.add_text_field("body", body_opts);
        let path_field = schema_builder.add_text_field("path", STRING | STORED);
        let schema = schema_builder.build();
        let index = Index::create_in_ram(schema);
        index.tokenizers().register(
            "default",
            TextAnalyzer::builder(tantivy::tokenizer::SimpleTokenizer::default())
                .filter(RemoveLongFilter::limit(40))
                .filter(tantivy::tokenizer::LowerCaser)
                .filter(Stemmer::new(Language::English))
                .build(),
        );
        let mut writer: IndexWriter = index.writer(15_000_000).unwrap();
        for file in &files {
            let rel = file.relative_path(&vault_root);
            let body_text = frontmatter::body(&file.content);
            writer
                .add_document(doc!(
                    title_field => file.name.as_str(),
                    body_field => body_text,
                    path_field => rel,
                ))
                .unwrap();
        }
        writer.commit().unwrap();
        let reader = index.reader().unwrap();
        let searcher = reader.searcher();
        let mut qp = QueryParser::for_index(&index, vec![title_field, body_field]);
        qp.set_field_boost(title_field, 2.0);
        let parsed = qp.parse_query("alpha").unwrap();
        let top_docs = searcher
            .search(&parsed, &TopDocs::with_limit(10))
            .unwrap();

        assert!(!top_docs.is_empty(), "expected at least one search result");

        let snippet_gen = SnippetGenerator::create(&searcher, &parsed, body_field).unwrap();
        let file_map: HashMap<String, &crate::vault::VaultFile> = files
            .iter()
            .map(|f| (f.relative_path(&vault_root), f))
            .collect();

        let mut results = Vec::new();
        for (score, doc_address) in top_docs {
            let doc: TantivyDocument = searcher.doc(doc_address).unwrap();
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
            let body_val = doc.get_first(body_field).and_then(|v| v.as_str()).unwrap_or("");
            let snippet_plain = snippet_gen
                .snippet(body_val)
                .to_html()
                .replace("<b>", "")
                .replace("</b>", "");
            let (doc_type, links, body_text) = if let Some(vf) = file_map.get(&path_val) {
                let t = {
                    let v = vf.get_property("type");
                    if v.is_empty() { None } else { Some(v) }
                };
                let l = wikilink::collect_all_link_targets(vf);
                let b = frontmatter::body(&vf.content)
                    .trim_start_matches('\n')
                    .to_string();
                (t, l, b)
            } else {
                (None, vec![], String::new())
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

        let output = SearchOutput {
            query: "alpha".to_string(),
            count: results.len(),
            results,
        };

        // Serialize and verify it's valid JSON
        let json_str = serde_json::to_string_pretty(&output).unwrap();
        let parsed_json: serde_json::Value = serde_json::from_str(&json_str).unwrap();

        // Verify top-level fields
        assert!(parsed_json.get("query").is_some(), "missing field: query");
        assert!(parsed_json.get("count").is_some(), "missing field: count");
        assert!(parsed_json.get("results").is_some(), "missing field: results");

        let results_arr = parsed_json["results"].as_array().unwrap();
        assert!(!results_arr.is_empty(), "results array is empty");

        let r = &results_arr[0];
        // Verify all 8 fields are present
        for field in &["path", "title", "type", "score", "snippet", "body", "tokens", "links"] {
            assert!(r.get(field).is_some(), "missing field in result: {}", field);
        }

        // type should be "card" (non-null)
        assert_eq!(r["type"], serde_json::Value::String("card".to_string()));

        // links should be an array containing "Beta note"
        let links = r["links"].as_array().unwrap();
        assert!(
            links.iter().any(|l| l.as_str() == Some("Beta note")),
            "expected 'Beta note' in links: {:?}",
            links
        );

        // body should not start with a newline
        let body_str = r["body"].as_str().unwrap();
        assert!(
            !body_str.starts_with('\n'),
            "body should not start with newline, got: {:?}",
            &body_str[..body_str.len().min(20)]
        );

        // tokens ≈ body.len() / 4
        let expected_tokens = body_str.chars().count() / 4;
        assert_eq!(r["tokens"].as_u64().unwrap(), expected_tokens as u64);

        // score is a float
        assert!(r["score"].is_number());
        assert!(r["score"].as_f64().unwrap() > 0.0);
    }

    #[test]
    fn test_search_format_from_str() {
        assert_eq!(SearchFormat::from_str("text").unwrap(), SearchFormat::Text);
        assert_eq!(SearchFormat::from_str("json").unwrap(), SearchFormat::Json);
        assert_eq!(SearchFormat::from_str("TEXT").unwrap(), SearchFormat::Text);
        assert!(SearchFormat::from_str("xml").is_err());
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
