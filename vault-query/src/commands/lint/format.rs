/// Output format for `vault-query lint`. Distinct from `crate::output::Format` —
/// findings carry per-rule `data` payloads that don't fit the table model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, clap::ValueEnum)]
pub enum LintFormat {
    /// One line per finding: `[severity] rule  file: message`
    #[default]
    Text,
    /// JSON array of finding objects with stable top-level keys.
    Json,
    /// One line per rule that fired: `<rule>: <count>`, sorted by rule name.
    Summary,
}
