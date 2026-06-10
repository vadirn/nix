use std::collections::BTreeMap;

use anyhow::{anyhow, bail, Result};

use super::rule::Severity;

#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct LintConfig {
    #[serde(default)]
    pub rules: BTreeMap<String, Severity>,
}

/// Merge root config and CLI overrides into a per-rule effective severity map.
///
/// Only rules explicitly set by config or CLI appear in the output; the dispatcher
/// fills in defaults from each rule's `default_severity()` for anything absent.
///
/// Rule names are validated against the real registry (via `registry::rule_names()`);
/// any name that does not appear there is an error, both from config and from CLI overrides.
pub fn effective_severities(
    config: Option<&LintConfig>,
    cli_overrides: &[String],
) -> Result<BTreeMap<String, Severity>> {
    let known_rules = super::registry::rule_names();
    let mut result: BTreeMap<String, Severity> = BTreeMap::new();

    // Layer 1: root config entries
    if let Some(cfg) = config {
        for (name, severity) in &cfg.rules {
            if !known_rules.contains(&name.as_str()) {
                bail!(
                    "unknown lint rule in config: '{}' (known: {})",
                    name,
                    known_rules.join(", ")
                );
            }
            result.insert(name.clone(), *severity);
        }
    }

    // Layer 2: CLI overrides (each is "name=severity")
    for raw in cli_overrides {
        let (name, sev_str) = raw.split_once('=').ok_or_else(|| {
            anyhow!(
                "invalid --rule value '{}': expected 'name=severity' (e.g. 'orphan-card=warn')",
                raw
            )
        })?;

        if !known_rules.contains(&name) {
            bail!(
                "unknown lint rule '{}' in --rule flag (known: {})",
                name,
                known_rules.join(", ")
            );
        }

        let severity = parse_severity(sev_str).map_err(|_| {
            anyhow!(
                "unknown severity '{}' in --rule '{}': expected off, warn, or error",
                sev_str,
                raw
            )
        })?;

        result.insert(name.to_string(), severity);
    }

    Ok(result)
}

fn parse_severity(s: &str) -> Result<Severity> {
    // Delegate to serde so the logic is never duplicated.
    serde_json::from_str(&format!("\"{}\"", s))
        .map_err(|e| anyhow!("cannot parse severity '{}': {}", s, e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn config_with(rules: &[(&str, Severity)]) -> LintConfig {
        let mut map = BTreeMap::new();
        for (name, sev) in rules {
            map.insert(name.to_string(), *sev);
        }
        LintConfig { rules: map }
    }

    // -------------------------------------------------------------------------
    // effective_severities tests
    // -------------------------------------------------------------------------

    #[test]
    fn effective_root_only() {
        let cfg = config_with(&[("orphan-card", Severity::Warn)]);
        let result = effective_severities(Some(&cfg), &[]).unwrap();
        assert_eq!(result.get("orphan-card"), Some(&Severity::Warn));
        assert_eq!(result.len(), 1);
    }

    #[test]
    fn effective_cli_overrides_root_per_key() {
        let cfg = config_with(&[("orphan-card", Severity::Warn)]);
        let cli = vec!["orphan-card=error".to_string()];
        let result = effective_severities(Some(&cfg), &cli).unwrap();
        assert_eq!(result.get("orphan-card"), Some(&Severity::Error));
        assert_eq!(result.len(), 1);
    }

    #[test]
    fn effective_accepts_oversized_doc_rule_name() {
        // The parameterized rule must still register under its name, so config
        // and CLI can address it (e.g. `oversized_doc=off`).
        let cli = vec!["oversized_doc=off".to_string()];
        let result = effective_severities(None, &cli).unwrap();
        assert_eq!(result.get("oversized_doc"), Some(&Severity::Off));
    }

    #[test]
    fn effective_cli_unknown_rule_errors() {
        let cli = vec!["does-not-exist=warn".to_string()];
        let err = effective_severities(None, &cli).unwrap_err();
        assert!(
            format!("{:#}", err).contains("does-not-exist"),
            "error must mention the unknown rule name"
        );
    }

    #[test]
    fn effective_config_unknown_rule_errors() {
        let cfg = config_with(&[("does-not-exist", Severity::Warn)]);
        let err = effective_severities(Some(&cfg), &[]).unwrap_err();
        assert!(
            format!("{:#}", err).contains("does-not-exist"),
            "error must mention the unknown rule name"
        );
    }

    #[test]
    fn effective_cli_unknown_severity_errors() {
        let cli = vec!["orphan-card=info".to_string()];
        let err = effective_severities(None, &cli).unwrap_err();
        let msg = format!("{:#}", err);
        assert!(
            msg.contains("info"),
            "error must mention the bad severity string, got: {}",
            msg
        );
    }

    #[test]
    fn effective_cli_malformed_errors() {
        let cli = vec!["no-equals-sign".to_string()];
        let err = effective_severities(None, &cli).unwrap_err();
        assert!(
            format!("{:#}", err).contains("no-equals-sign"),
            "error must echo the malformed string"
        );
    }
}
