/// Output format for `vault-query lint`. Distinct from `crate::output::Format` —
/// findings carry per-rule `data` payloads that don't fit the table model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum LintFormat {
    /// One line per finding: `[severity] rule  file: message`
    Text,
    // Json and Summary land in Step 6.
}

impl Default for LintFormat {
    fn default() -> Self {
        LintFormat::Text
    }
}
