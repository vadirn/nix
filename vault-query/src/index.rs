//! Shared BM25 retrieval core: the Tantivy schema, the bilingual analysis chain,
//! and the query sanitizer used by every search site (`consult` and `search`).
//!
//! This module depends only on `tantivy` + `frontmatter`; it holds the
//! infrastructure that both commands reuse so neither reaches sideways into the
//! other. Consult-specific scoring (`bm25_rank`, `stemmed_tokens`) and search's
//! result shaping stay in their respective command modules.

use std::path::Path;

use anyhow::Result;
use tantivy::schema::*;
use tantivy::tokenizer::{Language, LowerCaser, RemoveLongFilter, SimpleTokenizer, Stemmer, TextAnalyzer};
use tantivy::{doc, Index, IndexWriter};

use crate::frontmatter;
use crate::vault::VaultFile;

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
///     nothing reads it back — coverage reads `stored_body`)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_query_replaces_metacharacters() {
        assert_eq!(sanitize_query("structure the workflow: plan first"), "structure the workflow  plan first");
        assert_eq!(sanitize_query("retry - backoff"), "retry   backoff");
        assert_eq!(sanitize_query("title:value"), "title value");
        assert_eq!(sanitize_query("no specials here"), "no specials here");
    }
}
