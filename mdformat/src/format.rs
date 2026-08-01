//! `format` — every rewriting rule in one pass, and the predicate that says a
//! document is already in normal form.
//!
//! # The contract
//!
//! [`format`] is a **retraction onto a normal form**, which is two clauses:
//!
//! - **corrective** — [`Check::is_normal`] holds of `format(f)` for every `f`;
//! - **fixpoint** — `format(f) == f` for every `f` of which `is_normal` already
//!   holds.
//!
//! Together they give idempotence, which is why the two are stated separately
//! rather than as "running it twice changes nothing": that formulation is
//! satisfied by a rule that alternates between two forms on the first pass and
//! settles on neither.
//!
//! # Why the predicate is derived from the rules, not written beside them
//!
//! Every rule here **declines** some construct. [`crate::table::pad`] declines a
//! ragged table, because comrak does not model raggedness and padding one would
//! either delete a long row's overflow or materialize a short row's missing
//! cell. [`crate::normalize`] declines any document whose gaps are undefined
//! (the input fails the partition) or whose re-parse the rewrite would change.
//!
//! A hand-written predicate would have to reproduce that list, and the moment
//! it fell out of step the corrective clause would fail on every file holding a
//! declined construct — and the failure would be the predicate's, not the
//! rule's. So the predicate is not written beside the rule at all. It **is** the
//! rule:
//!
//! > a document is normal for a rule exactly when the rule's own yield for it
//! > is the document unchanged.
//!
//! [`RuleRun::yielded`] is that yield — the guarded output when every oracle
//! cleared, and the **input verbatim** when the rule declined. So a declined
//! document is normal because the rule leaves it alone, and a declined
//! construct is normal because it produces no edit. One field, `declined`, gates
//! both the bytes ([`RuleRun::accepted`]) and the exemption
//! ([`RuleRun::departures`]); there is no second list to drift. A rule that
//! grows a new declination inherits the matching exemption without touching this
//! module.
//!
//! The cost is that the fixpoint clause becomes a near-theorem rather than a
//! discovery — if no rule changes `f`, the composition cannot. That is the
//! honest state of affairs, and it is worth a regression test rather than a
//! hand-written specification that can be wrong.
//!
//! The cost's *other* half is sharper, and nothing in this module can pay it:
//! substitute the derived predicate into both clauses and `format = identity`
//! satisfies them — every document normal, zero departures, green. So the
//! standard of correctness comes from outside. `tests/normal_form.rs` holds
//! ill-formed inputs paired with **hand-written** expected bytes, one per rule
//! clause, asserted byte for byte; mutating `format` to return its input fails
//! 25 of its 28 fixtures while leaving both of its idempotence tests green,
//! which is the whole reason it exists. `corpus.sh` runs the idempotence half
//! over the vault.
//!
//! [`RuleRun::departures`] localizes the same predicate: `is_normal` is byte
//! equality, `departures` is *where* the equality fails. `RuleRun::new` asserts
//! the two agree, so the report cannot drift from the predicate either.
//!
//! # Two evaluations, deliberately
//!
//! [`format`] is a **pipeline**: each rule runs on the previous rule's yield.
//! [`check`] is **independent**: every rule runs on the same input.
//!
//! That is not an oversight. A pipeline's second stage reports positions in the
//! *intermediate* text, which are not coordinates in any file the caller has;
//! running every rule on the input keeps every reported line and column
//! addressable in the file on disk. It also makes the predicate **order-free**:
//! `check` cannot inherit the pipeline's order choice, so no claim about the
//! rules commuting is load-bearing for it.
//!
//! `check`'s conjunction is the stronger of the two readings — every rule
//! individually a no-op on `f` implies `format(f) == f`, while the converse
//! would additionally need that no rule undoes another's change. The strong
//! direction is the safe one for a check.
//!
//! # Nothing here writes a file
//!
//! [`format`] returns bytes; the CLI prints them to stdout. Whether a rewrite
//! may ever be applied in place is an undecided policy question, and this module
//! does not decide it. Every byte it yields either cleared the rule's own oracle
//! through [`crate::Normalization::accepted`] / [`crate::Padding::accepted`], or
//! was never touched by the rule that declined it.

use crate::normalize::normalize;
use crate::span::{LineIndex, PosError};
use crate::table::pad;

/// The rules [`format`] applies, in pipeline order.
///
/// Gaps before tables: gap normalization fixes the block skeleton, and table
/// padding then works line-locally on whatever skeleton it is handed. The two
/// were measured to commute over the 1052-file corpus, but nothing here relies
/// on that — [`check`] evaluates each rule against the input independently, so
/// the predicate is order-free whatever this order is.
pub const RULES: &[&dyn Rule] = &[&GapRule, &TableRule];

/// One rewriting rule, as [`format`] and [`check`] see it.
///
/// Effectively sealed: [`RuleRun::new`] is crate-private, so every rule's
/// verdict is built at the one site that ties the bytes, the predicate and the
/// exemption together. Implementing this outside the crate is possible only by
/// producing a `RuleRun`, which cannot be done.
pub trait Rule {
    /// Short identifier, used in reports.
    fn name(&self) -> &'static str;

    /// Run the rule over `source`.
    ///
    /// `Err` carries every sourcepos that does not name a byte range, exactly
    /// as [`crate::fixpoint`] does.
    fn run(&self, source: &str, opts: &mdstruct::Options) -> Result<RuleRun, Vec<PosError>>;
}

/// One place `source` departs from a rule's normal form, located in `source`'s
/// own coordinates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Departure {
    /// 1-based line.
    pub line: usize,
    /// 1-based column.
    pub column: usize,
    /// What is there now and what the normal form wants, in one line.
    pub what: String,
}

/// One construct a rule declined to touch, leaving it verbatim. A construct
/// listed here contributes no [`Departure`], which is what makes the document
/// normal despite holding it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Exemption {
    /// 1-based line the construct starts on.
    pub line: usize,
    pub why: String,
}

/// One rule's verdict on one document.
///
/// Construct through [`Rule::run`]. The bytes come out of [`RuleRun::yielded`]
/// or [`RuleRun::accepted`]; the predicate is [`RuleRun::is_normal`]; the
/// locations are [`RuleRun::departures`]. All four are functions of the same
/// two fields, which is the point — see the module docs.
#[derive(Debug, Clone)]
pub struct RuleRun {
    /// The rule that produced this, per [`Rule::name`].
    pub rule: &'static str,
    /// The bytes this rule yields: see [`RuleRun::yielded`].
    output: String,
    /// Why the rule declined the whole document, when it did. `None` means
    /// every guard cleared and `output` is a rewrite the oracles accepted.
    pub declined: Option<String>,
    /// Where the rule would rewrite. Read through [`RuleRun::departures`],
    /// which is empty for a declined document.
    changes: Vec<Departure>,
    /// Constructs inside the document the rule declined individually.
    pub exempt: Vec<Exemption>,
    /// `yielded() == source`, decided once at construction.
    normal: bool,
}

impl RuleRun {
    /// The one construction site, and the one place the bytes, the predicate
    /// and the exemption are tied together.
    ///
    /// `output` is the rule's candidate rewrite. When `declined` is `Some` the
    /// candidate is discarded here and the rule yields `source` instead, so a
    /// declined rule cannot later hand out bytes no oracle cleared.
    pub(crate) fn new(
        rule: &'static str,
        source: &str,
        output: String,
        declined: Option<String>,
        changes: Vec<Departure>,
        exempt: Vec<Exemption>,
    ) -> Self {
        let output = if declined.is_some() {
            source.to_string()
        } else {
            output
        };
        let normal = output == source;
        // The bridge between the predicate and its localization: `is_normal`
        // is byte equality with the rule's yield, `departures` is where that
        // equality fails, and a rule whose two disagree is misreporting one of
        // them. Held as an assertion rather than as a comment because the
        // correspondence is the whole reason this type exists.
        debug_assert_eq!(
            normal,
            declined.is_some() || changes.is_empty(),
            "rule {rule}: is_normal and departures disagree"
        );
        RuleRun {
            rule,
            output,
            declined,
            changes,
            exempt,
            normal,
        }
    }

    /// The bytes this rule yields for its input: its guarded rewrite, or the
    /// input verbatim when it declined. This is what [`format`] passes to the
    /// next stage.
    pub fn yielded(&self) -> &str {
        &self.output
    }

    /// The rewritten bytes, or `None` when a guard refused them. The only
    /// accessor that asserts the bytes differ from the input *and* cleared the
    /// rule's oracles.
    pub fn accepted(&self) -> Option<&str> {
        self.declined.is_none().then_some(&*self.output)
    }

    /// Whether the input is already in this rule's normal form — that is,
    /// whether the rule's yield is the input unchanged.
    pub fn is_normal(&self) -> bool {
        self.normal
    }

    /// Where the input departs from this rule's normal form.
    ///
    /// Empty exactly when [`RuleRun::is_normal`] holds, and therefore empty for
    /// a declined document: a rule that leaves a document alone cannot be said
    /// to find fault with it. A construct the rule declined individually
    /// likewise produces no entry, because it produces no edit.
    pub fn departures(&self) -> &[Departure] {
        if self.declined.is_some() {
            &self.changes[..0]
        } else {
            &self.changes
        }
    }
}

/// The result of applying every rule in [`RULES`], in order.
#[derive(Debug, Clone)]
pub struct Format {
    /// One entry per rule, in pipeline order, each run on the previous stage's
    /// [`RuleRun::yielded`] bytes.
    pub stages: Vec<RuleRun>,
    /// The bytes after every rule has run.
    pub output: String,
    /// Whether `output` differs from the input.
    pub changed: bool,
}

impl Format {
    /// Every rule that declined the document at the stage it saw, as
    /// `(rule, reason)`. A declination is not a failure: the stage passed its
    /// input through untouched.
    pub fn declined(&self) -> impl Iterator<Item = (&'static str, &str)> {
        self.stages
            .iter()
            .filter_map(|s| s.declined.as_deref().map(|r| (s.rule, r)))
    }

    /// Every construct a rule declined individually, as `(rule, exemption)`.
    pub fn exempt(&self) -> impl Iterator<Item = (&'static str, &Exemption)> {
        self.stages
            .iter()
            .flat_map(|s| s.exempt.iter().map(move |e| (s.rule, e)))
    }
}

/// Apply every rule in [`RULES`] to `source` and return the result.
///
/// Each rule runs on the previous rule's yield, so one call does what chaining
/// the single-rule verbs through stdout would do — without the chaining, and
/// without a stage ever seeing bytes an oracle refused: a rule that declines
/// passes its input through verbatim.
///
/// Writes nothing. `Err` carries every sourcepos that does not name a byte
/// range, exactly as [`crate::fixpoint`] does.
pub fn format(source: &str, opts: &mdstruct::Options) -> Result<Format, Vec<PosError>> {
    let mut current = source.to_string();
    let mut stages = Vec::with_capacity(RULES.len());
    for rule in RULES {
        let run = rule.run(&current, opts)?;
        current = run.yielded().to_string();
        stages.push(run);
    }
    Ok(Format {
        changed: current != source,
        output: current,
        stages,
    })
}

/// Whether a document is in normal form, and where it is not.
#[derive(Debug, Clone)]
pub struct Check {
    /// One entry per rule in [`RULES`], every one run against the **same**
    /// input — see the module docs on why this is not the pipeline.
    pub rules: Vec<RuleRun>,
}

impl Check {
    /// Whether every rule finds the document already in its normal form.
    pub fn is_normal(&self) -> bool {
        self.rules.iter().all(RuleRun::is_normal)
    }

    /// Every departure from normal form, as `(rule, departure)`, with every
    /// line and column addressing the checked input.
    pub fn departures(&self) -> impl Iterator<Item = (&'static str, &Departure)> {
        self.rules
            .iter()
            .flat_map(|r| r.departures().iter().map(move |d| (r.rule, d)))
    }

    /// Every rule that declined the whole document, as `(rule, reason)`.
    pub fn declined(&self) -> impl Iterator<Item = (&'static str, &str)> {
        self.rules
            .iter()
            .filter_map(|r| r.declined.as_deref().map(|reason| (r.rule, reason)))
    }

    /// Every construct a rule declined individually, as `(rule, exemption)`.
    pub fn exempt(&self) -> impl Iterator<Item = (&'static str, &Exemption)> {
        self.rules
            .iter()
            .flat_map(|r| r.exempt.iter().map(move |e| (r.rule, e)))
    }
}

/// Test `source` against every rule's normal form without rewriting it.
///
/// Unlike [`format`], every rule runs against `source` itself, so every
/// reported position is a coordinate in `source`.
pub fn check(source: &str, opts: &mdstruct::Options) -> Result<Check, Vec<PosError>> {
    let mut rules = Vec::with_capacity(RULES.len());
    for rule in RULES {
        rules.push(rule.run(source, opts)?);
    }
    Ok(Check { rules })
}

/// Blank-line gaps between top-level blocks — [`crate::normalize`] as a
/// [`Rule`].
#[derive(Debug, Clone, Copy)]
pub struct GapRule;

impl Rule for GapRule {
    fn name(&self) -> &'static str {
        "gaps"
    }

    fn run(&self, source: &str, opts: &mdstruct::Options) -> Result<RuleRun, Vec<PosError>> {
        let n = normalize(source, opts)?;
        // Both of this rule's declinations, in the order `normalize` decides
        // them: without the partition the gap is not definable at all, and
        // without re-parse equivalence the rewrite is not faithful.
        let declined = if !n.input_partition.is_partition() {
            Some(format!(
                "the input fails the partition oracle ({} violations), so its gaps are not defined",
                n.input_partition.violations.len()
            ))
        } else {
            n.structure
                .as_ref()
                .map(|d| format!("normalizing changes the parse: {d}"))
        };
        let idx = LineIndex::new(source);
        let changes = n
            .gaps
            .iter()
            .map(|g| {
                let (line, column) = idx.position_of(g.start);
                Departure {
                    line,
                    column,
                    what: format!(
                        "the gap between {} and {} holds {} where the normal form is {}",
                        g.prev,
                        g.next,
                        escape_whitespace(&g.old),
                        escape_whitespace(g.new)
                    ),
                }
            })
            .collect();
        // This rule declines whole documents only; it has no per-construct
        // exemption, because the constructs it is silent about (a blank line
        // inside a container) are outside its scope rather than declined.
        Ok(RuleRun::new(
            self.name(),
            source,
            n.output,
            declined,
            changes,
            Vec::new(),
        ))
    }
}

/// Table cell padding — [`crate::table::pad`] as a [`Rule`].
#[derive(Debug, Clone, Copy)]
pub struct TableRule;

impl Rule for TableRule {
    fn name(&self) -> &'static str {
        "tables"
    }

    fn run(&self, source: &str, opts: &mdstruct::Options) -> Result<RuleRun, Vec<PosError>> {
        let p = pad(source, opts)?;
        // `pad`'s two whole-document guards. Its `input_partition` is
        // deliberately absent: padding is defined by row sourcepos and
        // whole-line ranges, so unlike a gap rewrite it does not need the
        // partition, and gating on it here would decline documents the rule
        // itself accepts.
        let declined = p
            .structure
            .as_ref()
            .map(|d| format!("padding changes the parse: {d}"))
            .or_else(|| {
                p.violation
                    .as_ref()
                    .map(|v| format!("padding moved more than whitespace: {v}"))
            });
        let changes = p
            .changes
            .iter()
            .map(|c| Departure {
                line: c.line,
                column: first_difference_column(&c.old, &c.new),
                what: format!(
                    "the table line is {} where the normal form is {}",
                    escape_whitespace(&c.old),
                    escape_whitespace(&c.new)
                ),
            })
            .collect();
        // The per-construct exemption: a declined table produces no edit, so it
        // produces no departure, so a document holding one is normal.
        let exempt = p
            .skipped
            .iter()
            .map(|s| Exemption {
                line: s.line,
                why: format!("the table is left verbatim: {}", s.reason),
            })
            .collect();
        Ok(RuleRun::new(
            self.name(),
            source,
            p.output,
            declined,
            changes,
            exempt,
        ))
    }
}

/// 1-based character column at which two single-line strings first differ; the
/// end of the shorter when one is a prefix of the other.
fn first_difference_column(a: &str, b: &str) -> usize {
    let common = a
        .chars()
        .zip(b.chars())
        .position(|(x, y)| x != y)
        .unwrap_or_else(|| a.chars().count().min(b.chars().count()));
    common + 1
}

/// `s` on one line, quoted, with line endings and tabs escaped — so a
/// whitespace-only difference is legible in a one-line report.
pub fn escape_whitespace(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '"' => out.push_str("\\\""),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts() -> mdstruct::Options {
        mdstruct::Options::default()
    }

    fn fmt(source: &str) -> Format {
        format(source, &opts()).expect("spans convert")
    }

    fn chk(source: &str) -> Check {
        check(source, &opts()).expect("spans convert")
    }

    #[test]
    fn one_call_applies_both_rules() {
        // Two blank lines to collapse and a table to pad, in one invocation.
        let src = b"# H\n\n\n| key | value |\n| --- | --- |\n| a | longer |\n";
        let out = fmt(std::str::from_utf8(src).unwrap());
        assert_eq!(
            out.output,
            "# H\n\n| key | value |\n| --- | ------ |\n| a   | longer |\n"
        );
        assert!(out.changed);
    }

    #[test]
    fn an_already_formatted_document_is_a_fixpoint() {
        let src =
            std::str::from_utf8(b"# H\n\n| key | value |\n| --- | ------ |\n| a   | longer |\n")
                .unwrap();
        let out = fmt(src);
        assert!(!out.changed);
        assert_eq!(out.output, src);
        assert!(chk(src).is_normal());
    }

    #[test]
    fn check_locates_a_departure_in_the_inputs_own_coordinates() {
        let src = std::str::from_utf8(b"# H\n\n\npara\n").unwrap();
        let c = chk(src);
        assert!(!c.is_normal());
        let found: Vec<_> = c.departures().collect();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].0, "gaps");
        // The gap opens at the heading's last content byte + 1 — byte 3, which
        // is L1:4 — because the gap is measured against content-tight spans,
        // not against the trailing-newline-inclusive raw ones.
        assert_eq!((found[0].1.line, found[0].1.column), (1, 4));
    }

    #[test]
    fn a_declined_table_is_exempt_rather_than_a_departure() {
        // A ragged row makes `pad` decline the table; the document holds no
        // other departure, so it is normal — the exemption and the declination
        // are the same fact, not two lists.
        let src = std::str::from_utf8(b"| a | b | c |\n| --- | --- | --- |\n| 1 | 2 |\n").unwrap();
        let c = chk(src);
        assert!(c.is_normal(), "{:?}", c.departures().collect::<Vec<_>>());
        assert_eq!(c.exempt().count(), 1);
        assert_eq!(fmt(src).output, src);
    }

    #[test]
    fn a_declined_document_yields_its_input_and_reports_no_departure() {
        // `tests/normalize.rs` pins this one: deleting the head whitespace
        // promotes the leading `---` into front matter, so the structure guard
        // refuses the rewrite. The rule then yields its input, which is what
        // makes the document normal — the exemption is the declination, read
        // off the same field.
        let src = std::str::from_utf8(b"\n\n---\nk: v\n---\n").unwrap();
        let gaps = GapRule.run(src, &opts()).expect("spans convert");
        assert!(gaps.declined.is_some(), "the guard must refuse this");
        assert_eq!(gaps.yielded(), src);
        assert_eq!(gaps.accepted(), None);
        assert!(gaps.is_normal());
        assert!(gaps.departures().is_empty());
        assert!(chk(src).is_normal());
        assert_eq!(fmt(src).output, src);
    }

    #[test]
    fn is_normal_agrees_with_departures_on_every_rule() {
        // The bridge `RuleRun::new` asserts, checked here over inputs that
        // exercise both sides of it.
        for src in [
            &b"# H\n\npara\n"[..],
            &b"# H\n\n\npara\n"[..],
            &b"| a | b |\n| --- | --- |\n| 1 | 2 |\n"[..],
            &b"| a | b | c |\n| --- | --- | --- |\n| 1 | 2 |\n"[..],
            &b""[..],
            &b"\n\n   \n"[..],
        ] {
            let src = std::str::from_utf8(src).unwrap();
            for run in chk(src).rules {
                assert_eq!(
                    run.is_normal(),
                    run.departures().is_empty(),
                    "rule {} on {src:?}",
                    run.rule
                );
                assert_eq!(run.is_normal(), run.yielded() == src, "rule {}", run.rule);
            }
        }
    }

    #[test]
    fn format_never_yields_bytes_a_declining_rule_produced() {
        // Every stage's output is either its own accepted bytes or its input.
        let src = std::str::from_utf8(b"\n\n---\nk: v\n---\n").unwrap();
        let out = fmt(src);
        assert_eq!(out.declined().count(), 1, "the specimen must decline once");
        for stage in &out.stages {
            if stage.declined.is_some() {
                assert_eq!(stage.accepted(), None);
            } else {
                assert_eq!(stage.accepted(), Some(stage.yielded()));
            }
        }
    }
}
