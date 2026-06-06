//! CLI wiring for `vault-query consult <task>` (Backlog item 5, Step D).
//!
//! Exit codes (Decision 4):
//!   0 — ConsultOutcome::Selected (docs returned, printed to stdout)
//!   4 — ConsultOutcome::Abstain  (no confident match; near_misses printed to stdout)
//!   1 — IO / config / scan error (propagated via anyhow, printed by main)

use std::str::FromStr;

use anyhow::Result;
use serde::Serialize;

use crate::commands::consult::{ConsultMode, ConsultOutcome, NearMiss, SelectedDoc, run_consult};
use crate::config::{ConsultConfig, ResolvedConfig};
use crate::vault;

// ---------------------------------------------------------------------------
// Format enum
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ConsultFormat {
    Markdown,
    Json,
}

impl FromStr for ConsultFormat {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "markdown" | "md" => Ok(ConsultFormat::Markdown),
            "json" => Ok(ConsultFormat::Json),
            _ => Err(format!("unknown format: {} (expected markdown or json)", s)),
        }
    }
}

impl std::fmt::Display for ConsultFormat {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConsultFormat::Markdown => write!(f, "markdown"),
            ConsultFormat::Json => write!(f, "json"),
        }
    }
}

// ---------------------------------------------------------------------------
// JSON envelope types (Decision 3)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct JsonSelectedDoc {
    path: String,
    title: String,
    #[serde(rename = "type")]
    doc_type: Option<String>,
    score: f32,
    body: String,
    tokens: usize,
    links: Vec<String>,
}

#[derive(Serialize)]
struct JsonSelected {
    status: &'static str,
    query: String,
    total_tokens: usize,
    docs: Vec<JsonSelectedDoc>,
}

#[derive(Serialize)]
struct JsonNearMiss {
    path: String,
    title: String,
    score: f32,
    matched_terms: Vec<String>,
}

#[derive(Serialize)]
struct JsonAbstain {
    status: &'static str,
    query: String,
    reason: String,
    near_misses: Vec<JsonNearMiss>,
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

fn render_markdown_selected(_query: &str, docs: &[SelectedDoc], total_tokens: usize) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "<!-- vault-query consult: {} doc(s), ~{} tokens -->\n\n",
        docs.len(),
        total_tokens
    ));
    for doc in docs {
        // Section heading: title + relative path
        out.push_str(&format!("## {} ({})\n\n", doc.title, doc.path));
        out.push_str(doc.body.trim_end());
        out.push_str("\n\n");
    }
    // Remove trailing blank line
    let trimmed = out.trim_end().to_string();
    trimmed + "\n"
}

fn render_markdown_abstain(_query: &str, near_misses: &[NearMiss], reason: &str) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "<!-- vault-query consult: no confident match ({}) -->\n",
        reason
    ));
    if near_misses.is_empty() {
        out.push_str("No near-misses found. Try broader terms.\n");
    } else {
        out.push_str("Near-misses (reformulate with these terms):\n\n");
        for nm in near_misses {
            let terms = if nm.matched_terms.is_empty() {
                "(none)".to_string()
            } else {
                nm.matched_terms.join(", ")
            };
            out.push_str(&format!("- **{}** ({}) — matched: {}\n", nm.title, nm.path, terms));
        }
    }
    out
}

fn render_json_selected(query: &str, docs: &[SelectedDoc], total_tokens: usize) -> Result<String> {
    let envelope = JsonSelected {
        status: "selected",
        query: query.to_string(),
        total_tokens,
        docs: docs
            .iter()
            .map(|d| JsonSelectedDoc {
                path: d.path.clone(),
                title: d.title.clone(),
                doc_type: d.doc_type.clone(),
                score: d.score,
                body: d.body.clone(),
                tokens: d.tokens,
                links: d.links.clone(),
            })
            .collect(),
    };
    Ok(serde_json::to_string_pretty(&envelope)?)
}

fn render_json_abstain(query: &str, near_misses: &[NearMiss], reason: &str) -> Result<String> {
    let envelope = JsonAbstain {
        status: "abstain",
        query: query.to_string(),
        reason: reason.to_string(),
        near_misses: near_misses
            .iter()
            .map(|nm| JsonNearMiss {
                path: nm.path.clone(),
                title: nm.title.clone(),
                score: nm.score,
                matched_terms: nm.matched_terms.clone(),
            })
            .collect(),
    };
    Ok(serde_json::to_string_pretty(&envelope)?)
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Run the consult command. Returns the typed exit code:
///   0 = selected, 4 = abstain, 1 = error (propagated via anyhow).
pub fn run(
    task: &str,
    cfg: &ResolvedConfig,
    cli_types: &[String],
    ambient: bool,
    format: ConsultFormat,
    threshold_override: Option<f32>,
) -> Result<i32> {
    let vault_root = &cfg.vault_root;

    // Scan the vault using the same path as `search`: full vault root + vaultignore.
    let files = vault::scan(vault_root, vault_root, Some(&cfg.ignore))?;

    // Resolve ConsultConfig: use config block if present, else default.
    let mut consult_config: ConsultConfig = cfg.consult.clone().unwrap_or_default();

    // Apply --threshold override if given.
    if let Some(t) = threshold_override {
        consult_config.threshold = Some(t);
    }

    // Resolve scope_types: CLI wins over config.
    let scope_types: Vec<String> = if !cli_types.is_empty() {
        cli_types.to_vec()
    } else {
        consult_config.types.clone()
    };

    // Resolve mode.
    let mode = if ambient {
        ConsultMode::Ambient
    } else {
        ConsultMode::Deliberate
    };

    let outcome = run_consult(task, &files, vault_root, &scope_types, &consult_config, mode)?;

    match outcome {
        ConsultOutcome::Selected { query, docs, total_tokens } => {
            let rendered = match format {
                ConsultFormat::Markdown => render_markdown_selected(&query, &docs, total_tokens),
                ConsultFormat::Json => render_json_selected(&query, &docs, total_tokens)?,
            };
            print!("{}", rendered);
            Ok(0)
        }
        ConsultOutcome::Abstain { query, near_misses, reason } => {
            let rendered = match format {
                ConsultFormat::Markdown => render_markdown_abstain(&query, &near_misses, &reason),
                ConsultFormat::Json => render_json_abstain(&query, &near_misses, &reason)?,
            };
            print!("{}", rendered);
            Ok(4)
        }
    }
}
