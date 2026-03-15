use anyhow::Result;
use regex::Regex;
use std::path::Path;
use tantivy::collector::TopDocs;
use tantivy::query::QueryParser;
use tantivy::schema::*;
use tantivy::tokenizer::TextAnalyzer;
use tantivy::{doc, Index, IndexWriter, SnippetGenerator};

use crate::{frontmatter, vault};

pub fn run(
    query: &str,
    vault_root: &Path,
    context: usize,
    subfolder: Option<&Path>,
    regex_mode: bool,
) -> Result<()> {
    if regex_mode {
        return run_regex(query, vault_root, context, subfolder);
    }
    run_bm25(query, vault_root, subfolder)
}

fn run_bm25(query: &str, vault_root: &Path, subfolder: Option<&Path>) -> Result<()> {
    let root = vault::resolve_root(vault_root, subfolder);

    let files = vault::scan(&root)?;

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

    // Register a simple tokenizer for title boosting
    index.tokenizers().register(
        "default",
        TextAnalyzer::builder(tantivy::tokenizer::SimpleTokenizer::default())
            .filter(tantivy::tokenizer::LowerCaser)
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

    let top_docs = searcher.search(&parsed, &TopDocs::with_limit(20))?;

    if top_docs.is_empty() {
        return Ok(());
    }

    let snippet_generator = SnippetGenerator::create(&searcher, &parsed, body)?;

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

    Ok(())
}

fn run_regex(
    query: &str,
    vault_root: &Path,
    context: usize,
    subfolder: Option<&Path>,
) -> Result<()> {
    let re = Regex::new(query)?;

    let root = vault::resolve_root(vault_root, subfolder);

    let files = vault::scan(&root)?;

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
