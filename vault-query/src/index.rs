//! Shared BM25 retrieval core: the corpus every search site (`consult` and
//! `search`) ranks over, and the field weights it scores with.
//!
//! The index and its bilingual analysis chain come from `mdsearch`; this module
//! only maps vault files onto its documents. It holds the infrastructure both
//! commands reuse so neither reaches sideways into the other. Consult-specific
//! scoring (`bm25_rank`, `stemmed_tokens`) and search's result shaping stay in
//! their respective command modules.

use std::path::Path;

use anyhow::Result;
use mdsearch::{Corpus, Doc, Scoring};

use crate::frontmatter;
use crate::vault::VaultFile;

/// Build the in-RAM BM25 corpus shared by every search site, so the sites
/// cannot drift in fields or analyzer.
///
/// Each file becomes one document:
///   - `id`          ← relative path, carried back on every hit
///   - `title`       ← `file.name` (the filename)
///   - `description` ← frontmatter `description:` precis
///   - `body`        ← `frontmatter::body()`
///
/// Every query goes through `mdsearch`'s one analysis chain, so no character is
/// query syntax and none needs escaping. Everything downstream of the ranking
/// stays in the caller, since those steps diverge between consult and search.
pub(crate) fn build_corpus(files: &[&VaultFile], vault_root: &Path) -> Result<Corpus> {
    let docs = files
        .iter()
        .map(|file| Doc {
            id: file.relative_path(vault_root),
            title: file.name.clone(),
            description: frontmatter::get_display(&file.frontmatter, "description"),
            body: frontmatter::body(&file.content).to_string(),
        })
        .collect();
    Corpus::build(docs)
}

/// The field weights for a title and a description boost. The body scores at 1.0.
pub(crate) fn scoring(title_boost: f32, description_boost: f32) -> Scoring {
    Scoring {
        title: title_boost,
        description: description_boost,
    }
}
