//! Per-node trust policy: the single owner of how frontmatter signals map to a
//! retrieval tier, and which tiers are "retired".
//!
//! `frontmatter` owns the typed accessors (`is_superseded`, `is_template`, …);
//! this module owns the *policy* layered on top of them so consult, search, and
//! lint classify by intent (`is_bottom`, `is_lint_exempt`) rather than by
//! re-comparing variants or re-reading flags at each call site.

use crate::frontmatter::{is_superseded, is_template};
use serde_yaml::Value;
use std::collections::BTreeMap;

/// Machine-legible per-node trust level (Decision 18). Retrieval ranks entries
/// by tier so unverified content cannot be served as ground (Decision 7). Ordered
/// worst-to-best; `multiplier()` gives the post-retrieval BM25 score factor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EpistemicTier {
    /// Currency lapsed: legacy `superseded: true`, `type: checkpoint`, or an
    /// explicit `epistemic_status: superseded`. Excluded from consult by default;
    /// labeled and heavily downranked in search.
    Superseded,
    /// Filed but not yet curated (e.g. agent-distilled output, D27). Real ground
    /// for a thin query, so downranked rather than excluded.
    Provisional,
    /// Curated / human-gated, and the trusted default for the ~955 existing notes
    /// that carry no `epistemic_status` key — an absent key MUST resolve here so
    /// the curated vault is not mass-downranked.
    Certified,
}

impl EpistemicTier {
    /// Post-retrieval score multiplier. Certified is neutral (1.0); the
    /// superseded factor matches the historical binary downrank (Decision 7).
    /// Both non-neutral values are uncalibrated — revisit with real data.
    pub fn multiplier(self) -> f32 {
        match self {
            EpistemicTier::Certified => 1.0,
            EpistemicTier::Provisional => 0.6,
            EpistemicTier::Superseded => 0.3,
        }
    }

    /// Whether this is the bottom tier: excluded from consult by default,
    /// dropped by search `--no-superseded`, and carried as the `superseded`
    /// output label. The single definition of "which tiers are retired", so
    /// call sites classify by intent rather than comparing to a variant.
    pub fn is_bottom(self) -> bool {
        self == EpistemicTier::Superseded
    }
}

/// Resolve a node's trust tier from frontmatter. The legacy `superseded: true`
/// flag and `type: checkpoint` collapse into `Superseded` so the existing
/// downrank is subsumed, not double-counted; an explicit `epistemic_status`
/// value otherwise wins. An absent or unrecognized key resolves to `Certified`
/// (the trusted default), keeping the unkeyed curated vault at full rank.
pub fn epistemic_tier(fm: &BTreeMap<String, Value>) -> EpistemicTier {
    // Legacy bottom-tier signals fold in first: a checkpoint or superseded-flagged
    // entry is bottom-tier regardless of any `epistemic_status` value.
    if is_superseded(fm) || fm.get("type").and_then(Value::as_str) == Some("checkpoint") {
        return EpistemicTier::Superseded;
    }
    match fm.get("epistemic_status").and_then(Value::as_str) {
        Some("superseded") => EpistemicTier::Superseded,
        Some("provisional") => EpistemicTier::Provisional,
        _ => EpistemicTier::Certified, // "certified", absent, or unrecognized
    }
}

/// Whether a file is exempt from content-level lint rules: bottom-tier entries
/// (superseded / checkpoint) and templates carry the same `type:` as real
/// content but are not curated content, so the rules that score curated entries
/// skip them through this one predicate.
pub fn is_lint_exempt(fm: &BTreeMap<String, Value>) -> bool {
    epistemic_tier(fm).is_bottom() || is_template(fm)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frontmatter::parse;

    #[test]
    fn epistemic_tier_absent_key_is_certified() {
        // The ~955 existing notes carry no epistemic_status key; absent MUST be
        // the trusted default (multiplier 1.0) so they are never mass-downranked.
        let fm = parse("---\ntype: card\n---\n").unwrap().unwrap();
        assert_eq!(epistemic_tier(&fm), EpistemicTier::Certified);
        assert_eq!(epistemic_tier(&fm).multiplier(), 1.0);
    }

    #[test]
    fn epistemic_tier_reads_explicit_status() {
        let prov = parse("---\nepistemic_status: provisional\n---\n").unwrap().unwrap();
        assert_eq!(epistemic_tier(&prov), EpistemicTier::Provisional);
        let cert = parse("---\nepistemic_status: certified\n---\n").unwrap().unwrap();
        assert_eq!(epistemic_tier(&cert), EpistemicTier::Certified);
        let sup = parse("---\nepistemic_status: superseded\n---\n").unwrap().unwrap();
        assert_eq!(epistemic_tier(&sup), EpistemicTier::Superseded);
    }

    #[test]
    fn epistemic_tier_folds_legacy_bottom_signals() {
        // superseded: true and type: checkpoint collapse into the bottom tier,
        // subsuming the historical binary downrank without double-counting.
        let flag = parse("---\nsuperseded: true\n---\n").unwrap().unwrap();
        assert_eq!(epistemic_tier(&flag), EpistemicTier::Superseded);
        let chk = parse("---\ntype: checkpoint\n---\n").unwrap().unwrap();
        assert_eq!(epistemic_tier(&chk), EpistemicTier::Superseded);
        // A legacy flag overrides a stray non-bottom epistemic_status value.
        let mixed = parse("---\nsuperseded: true\nepistemic_status: certified\n---\n")
            .unwrap()
            .unwrap();
        assert_eq!(epistemic_tier(&mixed), EpistemicTier::Superseded);
    }

    #[test]
    fn epistemic_tier_multiplier_ordering() {
        // certified > provisional > superseded — the load-bearing rank order.
        assert!(
            EpistemicTier::Certified.multiplier() > EpistemicTier::Provisional.multiplier()
        );
        assert!(
            EpistemicTier::Provisional.multiplier() > EpistemicTier::Superseded.multiplier()
        );
    }

    #[test]
    fn is_lint_exempt_covers_bottom_tier_and_templates() {
        // Bottom-tier (superseded / checkpoint) and templates are exempt; a
        // plain certified entry is not.
        let sup = parse("---\nsuperseded: true\n---\n").unwrap().unwrap();
        assert!(is_lint_exempt(&sup));
        let chk = parse("---\ntype: checkpoint\n---\n").unwrap().unwrap();
        assert!(is_lint_exempt(&chk));
        let tmpl = parse("---\ntype: card\ntemplate: true\n---\n").unwrap().unwrap();
        assert!(is_lint_exempt(&tmpl));
        let plain = parse("---\ntype: card\n---\n").unwrap().unwrap();
        assert!(!is_lint_exempt(&plain));
    }
}
