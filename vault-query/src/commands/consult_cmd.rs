//! CLI wiring for `vault-query consult <task>` (Backlog item 5, Step D).
//!
//! Exit codes (Decision 4):
//!   0 — ConsultOutcome::Selected (docs returned, printed to stdout)
//!   4 — ConsultOutcome::Abstain  (no confident match; near_misses printed to stdout)
//!   1 — IO / config / scan error (propagated via anyhow, printed by main)

use std::str::FromStr;

use anyhow::Result;
use serde::Serialize;

use crate::commands::consult::{
    ConsultDiagnostics, ConsultMode, ConsultOutcome, NearMiss, SelectedDoc, run_consult,
};
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

fn render_markdown_selected(docs: &[SelectedDoc], total_tokens: usize) -> String {
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

fn render_markdown_abstain(near_misses: &[NearMiss], reason: &str) -> String {
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
// JSONL invocation log (Decision 8, Backlog 6)
// ---------------------------------------------------------------------------

/// One JSONL record appended per `consult` invocation.
///
/// All diagnostic floats use `Option<f32>` because `serde_json` serializes
/// `f32::NAN`/`Infinity` as `null` only when wrapped in `Option`.
#[derive(Serialize)]
struct LogRecord<'a> {
    /// UTC epoch milliseconds (std time only — this binary has no async runtime).
    timestamp_ms: u128,
    query: &'a str,
    /// "deliberate" or "ambient".
    mode: &'a str,
    format: &'a str,
    /// "selected" or "abstain".
    outcome: &'a str,
    /// Populated only when outcome = "abstain".
    reason: Option<&'a str>,
    // Gate diagnostics
    top_score: Option<f32>,
    median_score: Option<f32>,
    coverage: Option<f32>,
    max_top3_coverage: Option<f32>,
    elbow_ratio: Option<f32>,
    num_returned: usize,
    // Selection summary
    num_selected: usize,
    total_tokens: usize,
    selected_paths: Vec<&'a str>,
    near_miss_titles: Vec<&'a str>,
    near_miss_scores: Vec<f32>,
}

/// Append one JSONL record to `log_path` (relative to `vault_root` or absolute).
/// Best-effort: any error is silently swallowed; the exit code is never affected.
fn append_log(
    log_path: &str,
    vault_root: &std::path::Path,
    query: &str,
    mode_str: &str,
    format_str: &str,
    outcome: &ConsultOutcome,
    diag: &ConsultDiagnostics,
) {
    let _ = append_log_inner(log_path, vault_root, query, mode_str, format_str, outcome, diag);
}

fn append_log_inner(
    log_path: &str,
    vault_root: &std::path::Path,
    query: &str,
    mode_str: &str,
    format_str: &str,
    outcome: &ConsultOutcome,
    diag: &ConsultDiagnostics,
) -> Result<()> {
    use std::io::Write;

    let path = {
        let p = std::path::Path::new(log_path);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            vault_root.join(p)
        }
    };

    // Create parent directory if it does not exist.
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let timestamp_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();

    let record: LogRecord = match outcome {
        ConsultOutcome::Selected { docs, total_tokens, .. } => LogRecord {
            timestamp_ms,
            query,
            mode: mode_str,
            format: format_str,
            outcome: "selected",
            reason: None,
            top_score: diag.top_score,
            median_score: diag.median_score,
            coverage: diag.coverage,
            max_top3_coverage: diag.max_top3_coverage,
            elbow_ratio: diag.elbow_ratio,
            num_returned: diag.num_returned,
            num_selected: docs.len(),
            total_tokens: *total_tokens,
            selected_paths: docs.iter().map(|d| d.path.as_str()).collect(),
            near_miss_titles: vec![],
            near_miss_scores: vec![],
        },
        ConsultOutcome::Abstain { near_misses, reason, .. } => LogRecord {
            timestamp_ms,
            query,
            mode: mode_str,
            format: format_str,
            outcome: "abstain",
            reason: Some(reason.as_str()),
            top_score: diag.top_score,
            median_score: diag.median_score,
            coverage: diag.coverage,
            max_top3_coverage: diag.max_top3_coverage,
            elbow_ratio: diag.elbow_ratio,
            num_returned: diag.num_returned,
            num_selected: 0,
            total_tokens: 0,
            selected_paths: vec![],
            near_miss_titles: near_misses.iter().map(|nm| nm.title.as_str()).collect(),
            near_miss_scores: near_misses.iter().map(|nm| nm.score).collect(),
        },
    };

    let mut line = serde_json::to_string(&record)?;
    line.push('\n');

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
    file.write_all(line.as_bytes())?;

    Ok(())
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

    let mode_str = mode.as_str();
    let format_str = format.to_string();

    let (outcome, diag) =
        run_consult(task, &files, vault_root, &scope_types, &consult_config, mode)?;

    // Best-effort JSONL logging (Decision 8). Any error is silently swallowed.
    if let Some(ref log_path) = consult_config.log_path {
        append_log(log_path, vault_root, task, mode_str, &format_str, &outcome, &diag);
    }

    match outcome {
        ConsultOutcome::Selected { query, docs, total_tokens } => {
            let rendered = match format {
                ConsultFormat::Markdown => render_markdown_selected(&docs, total_tokens),
                ConsultFormat::Json => render_json_selected(&query, &docs, total_tokens)?,
            };
            print!("{}", rendered);
            Ok(0)
        }
        ConsultOutcome::Abstain { query, near_misses, reason } => {
            let rendered = match format {
                ConsultFormat::Markdown => render_markdown_abstain(&near_misses, &reason),
                ConsultFormat::Json => render_json_abstain(&query, &near_misses, &reason)?,
            };
            print!("{}", rendered);
            Ok(4)
        }
    }
}
