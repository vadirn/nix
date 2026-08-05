//! `unintended-emphasis` — flags an emphasis run whose delimiters read as
//! literal text: two globs, a doubled-underscore identifier, a repeated fill-in
//! blank.
//!
//! CommonMark pairs two literal `*` characters in one paragraph into emphasis
//! whenever the first is left-flanking and the second right-flanking, which a
//! glob supplies for free: the `*` in `src/*.ts` sits between two punctuation
//! characters. So `src/*.ts and dist/*.js` already renders as italic in Obsidian
//! before any tool touches it, and `oxfmt` then normalizes the pair to `_`,
//! silently rewriting both extensions. comrak, `oxfmt`, and Obsidian all agree
//! with each other and all three disagree with the author — the defect is
//! authored, not introduced, so there is no oracle among the tools to consult.
//! Underscore runs fail through the same mechanism (`__init__` renders bold).
//!
//! Nothing can tell a literal glob asterisk from an intended emphasis marker;
//! that is an authorial-intent question. So this rule reports and never rewrites,
//! and it biases toward reporting: a human adjudicates every finding, and a false
//! positive costs one glance during review.

use crate::commands::lint::rule::{Finding, LintContext, Rule, Severity};
use crate::mdfacet::EmphasisSpan;

/// Longest run quoted back in a finding. A span can cover most of a paragraph
/// (the two paired delimiters may sit sentences apart), and the reader needs the
/// shape, not the payload.
const QUOTE_CAP: usize = 60;

pub struct UnintendedEmphasis;

impl Rule for UnintendedEmphasis {
    fn name(&self) -> &'static str {
        "unintended-emphasis"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warn
    }

    fn check(&self, ctx: &LintContext) -> Vec<Finding> {
        let mut findings = Vec::new();

        for file in ctx.files {
            let spans = crate::mdfacet::emphasis_spans(&file.content);
            let flagged: Vec<(&EmphasisSpan, &'static str)> = spans
                .iter()
                .filter_map(|s| shape(s).map(|sh| (s, sh)))
                .collect();

            for (span, shape) in &flagged {
                // `___x___` is an `Emph` wrapping a `Strong`: two inline nodes over
                // one authored hazard. Report the widest run and drop what nests
                // inside it, so the reader adjudicates the shape once.
                if flagged.iter().any(|(o, _)| {
                    o.start <= span.start && span.end <= o.end && !std::ptr::eq(*o, *span)
                }) {
                    continue;
                }
                let quoted = truncate(&span.text);
                findings.push(Finding {
                    rule: self.name(),
                    severity: self.default_severity(),
                    file: file.path.clone(),
                    // `Finding` carries no line field, so the line rides in both the
                    // human-readable message and the structured payload.
                    message: format!(
                        "line {}: `{}` parses as emphasis in {} shape — escape the delimiters or move the text into a code span",
                        span.line, quoted, shape
                    ),
                    data: Some(serde_json::json!({
                        "line": span.line,
                        "shape": shape,
                        "text": quoted,
                    })),
                });
            }
        }

        findings
    }
}

/// The shape that condemns this run, or `None` if it reads as ordinary emphasis.
/// Glob-or-path is tested first so a path spelled with underscores
/// (`__src/main.rs__`) reports as the path it is.
fn shape(span: &EmphasisSpan) -> Option<&'static str> {
    if is_glob_or_path(span) {
        return Some("glob-or-path");
    }
    if is_identifier_or_placeholder(span) {
        return Some("identifier-or-placeholder");
    }
    None
}

/// A run whose delimiters sit in a path or a glob.
///
/// This test reads the two characters flanking each delimiter and not the run's
/// content — a property of this test alone, not of the rule: the sibling
/// [`is_identifier_or_placeholder`] does inspect content, requiring a bare
/// identifier between the delimiters. What this test asserts is the narrower
/// claim that content is no evidence a delimiter is literal, since
/// `**src/main.rs**` and `**config.toml**` are ordinary bold that happens to name
/// a file. What betrays a literal delimiter is the delimiter being welded into a
/// token instead of framed by whitespace.
///
/// A delimiter is welded when path punctuation abuts it on either side, and the
/// run is flagged only when BOTH of its delimiters are welded. The conjunction is
/// what makes the test survive real prose: one welded end alone is the ordinary
/// either-or construction (`auto/**human**`, `_codex_/_vellum_`, `**/experiment
/// claim:**`), which fired on 14 intended runs across this vault; a glob welds
/// both ends, because `src/*.ts and dist/*.js` opens after a `/` onto a `.` and
/// closes on a `/`.
///
/// A closing `.` alone is not enough evidence: `after == '.'` is also the period
/// ending `this is *really*.`, and — the case that motivates the lookahead — the
/// period ending `auto/**human**.`, where the open already welds on the `/` of
/// `auto/` so the conjunction alone cannot save it. The close test asks one
/// character further, [`EmphasisSpan::after_next`], and counts the `.` as a weld
/// only when an alphanumeric follows it, as in the `md` of `**foo**.md`. A `.` at
/// end of input, or followed by whitespace, is ordinary sentence punctuation and
/// does not weld. The one asymmetry left is a `.` at the inner close, excluded
/// because `**/goal (outer framing).**` ends a sentence inside the bold.
///
/// # Why relaxing the conjunction and testing content instead does not work
///
/// The ticket proposed the opposite trade: accept ONE welded end, and recover the
/// precision by requiring the content to carry a path separator or a file
/// extension. Measured over this vault's 6693 emphasis runs on 2026-07-30, it
/// loses on both sides of the ledger.
///
/// Read the content clause faithfully — a `.` followed by a two-to-five-letter
/// extension at a component boundary, or a `/` joining two path-shaped
/// components, neither purely numeric — and it matches 168 runs. (An earlier
/// measurement recorded here put that at 552; that figure came from a scan
/// firing on a bare `.` or `/` ANYWHERE in the content, which also catches
/// `**14.5**`, `**A/B test**`, `**50/50 rule.**` and every multi-sentence bold.
/// The bare scan matches 1925 of the 6693. The clause was never the thing
/// measured, so it was never the thing refuted.)
///
/// AND'ing the faithful clause with `open_welded || close_welded` does reject the
/// 14 either-or runs, as predicted: `human`, `vellum` and `experiment claim:` are
/// not path-shaped. It still fails, because it adds 3 findings and recovers 0.
///
/// - It recovers nothing. The extension clause matches no one-welded run in this
///   vault at all. That is structural, not luck: CommonMark needs a closing `*`
///   to be right-flanking, and in glob text the character before it is the `/` of
///   `dist/*`, so a glob welds both ends by construction. The one shape that
///   escapes is a trailing literal `*` after a filename — `Compare src/*.ts to
///   the file main.ts*` — which this vault does not contain, and reaching it
///   would flag every sentence-final `**settings.json**.`
/// - It adds 3 false positives, all from the separator clause:
///   `**Track/Checkpoint**.`, `**Zig core + Swift/AppKit GUI**.`, and
///   `_style/structure_.` Each is a word-over-word alternation welded shut by a
///   sentence period, and each is structurally identical to a two-component
///   relative path. No content test separates `Track/Checkpoint` from `src/main`,
///   which is the same wall the either-or construction already put up.
fn is_glob_or_path(span: &EmphasisSpan) -> bool {
    let open_welded = matches!(span.before, Some('.') | Some('/'))
        || span.inner.starts_with('.')
        || span.inner.starts_with('/');
    // A trailing `/` always welds. A trailing `.` welds only when it reads as an
    // extension rather than a full stop — see the doc above for why `after`
    // alone cannot tell the two apart.
    let close_welded = span.inner.ends_with('/')
        || matches!(span.after, Some('/'))
        || (span.after == Some('.') && span.after_next.is_some_and(char::is_alphanumeric));
    open_welded && close_welded
}

/// A run whose delimiters belong to a code identifier or a fill-in blank.
///
/// Two tells, in the order they discriminate:
///
/// - A delimiter run of three or more (`___`, `***`). Emphasis needs one or two;
///   a longer run is a placeholder the author typed literally, and CommonMark
///   pairs it into `Emph`-wrapping-`Strong` when punctuation flanks it.
/// - Bare-identifier content under a DOUBLED `_` (`__init__`, `__G0__`). The
///   doubling is what carries the tell, not the underscore: `autoformat` routes
///   `.md` through `oxfmt`, which normalizes every intended italic to `_x_`, so a
///   singly-delimited `_word_` is this vault's canonical emphasis — 405 runs of
///   that spelling, all intended — while `__x__` is a spelling oxfmt never writes
///   for bold (it writes `**x**`) and so survives only where an author typed the
///   underscores as part of the name.
///
/// A retired third tell flagged EITHER delimiter welded to a word
/// (`before`/`after` alphanumeric), which caught `bug*004`-style asterisk
/// corruptions. It is gone, because it cannot tell a corruption from deliberate
/// intraword bold: CommonMark ENABLES asterisk intraword emphasis, so
/// `==**A**ffirmo.==` and `un**be**lievable` render exactly as the author asked.
/// The clause's only live findings were the four `**A**ffirmo` siblings — all
/// false — so retiring it costs the vault nothing and spends its whole
/// false-positive budget. Underscore needs no such tell: intraword `_` forms no
/// emphasis at all (`bug_004` is inert), so a `_` delimiter never welds to a word.
fn is_identifier_or_placeholder(span: &EmphasisSpan) -> bool {
    if span.run >= 3 {
        return true;
    }
    span.delimiter == '_'
        && span.run >= 2
        && !span.inner.is_empty()
        && span
            .inner
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// `s` capped at [`QUOTE_CAP`] characters, ellipsized when cut. Counts chars, not
/// bytes, so the cut lands on a character boundary.
fn truncate(s: &str) -> String {
    if s.chars().count() <= QUOTE_CAP {
        return s.to_string();
    }
    let kept: String = s.chars().take(QUOTE_CAP).collect();
    format!("{kept}…")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::lint::rule::LintContext;
    use std::path::PathBuf;

    fn make_file(name: &str, content: &str) -> crate::vault::VaultFile {
        crate::vault::VaultFile {
            name: name.to_string(),
            path: PathBuf::from(format!("/vault/{}.md", name)),
            content: content.to_string(),
            ..Default::default()
        }
    }

    fn check(content: &str) -> Vec<Finding> {
        let files = vec![make_file("Foo", content)];
        let root = PathBuf::from("/vault");
        let ctx = LintContext::build(&root, &files, &[]);
        UnintendedEmphasis.check(&ctx)
    }

    // Box 1 — two literal asterisks in glob-or-path shape.
    #[test]
    fn two_globs_in_one_paragraph_emit_one_finding() {
        let findings = check("Delete src/*.ts and dist/*.js before rebuilding.\n");
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, "unintended-emphasis");
        assert_eq!(findings[0].severity, Severity::Warn);
        // The finding names the file and the line in both channels.
        assert_eq!(findings[0].file, PathBuf::from("/vault/Foo.md"));
        assert!(
            findings[0]
                .message
                .starts_with("line 1: `*.ts and dist/*` parses as emphasis in glob-or-path shape"),
            "message was {:?}",
            findings[0].message
        );
        let data = findings[0].data.as_ref().unwrap();
        assert_eq!(data["line"], 1);
        assert_eq!(data["shape"], "glob-or-path");
        assert_eq!(data["text"], "*.ts and dist/*");
    }

    // Box 2 — the same shape inside a code span.
    #[test]
    fn globs_inside_a_code_span_emit_nothing() {
        let findings = check("Delete `rm src/*.ts and dist/*.js` before rebuilding.\n");
        assert_eq!(findings.len(), 0);
    }

    // Box 3 — the same shape already escaped.
    #[test]
    fn escaped_globs_emit_nothing() {
        let findings = check("Delete src/\\*.ts and dist/\\*.js before rebuilding.\n");
        assert_eq!(findings.len(), 0);
    }

    // Box 4 — genuine prose emphasis.
    #[test]
    fn prose_emphasis_emits_nothing() {
        let findings = check("This is *really* important, and **nothing** else matters here.\n");
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn multi_word_prose_emphasis_emits_nothing() {
        let findings =
            check("This is *really quite* important, she said **do not touch it** loudly.\n");
        assert_eq!(findings.len(), 0);
    }

    // Box 5 — an identifier mentioned twice in one paragraph.
    //
    // The ticket's own specimen is `bug_004` twice, which parses to NO emphasis at
    // all: CommonMark forbids an intraword `_` from opening or closing a run, a
    // restriction unique to `_`. That is not a gap in this rule — where no
    // emphasis node exists the text renders literally and there is no hazard to
    // report. The `*` spelling of the same shape has no such restriction, pairs
    // into one run across the two mentions, and is flagged.
    #[test]
    fn underscore_identifier_twice_is_never_emphasis() {
        let findings = check("The fix for bug_004 landed last week, so bug_004 is closed.\n");
        assert_eq!(findings.len(), 0);
        assert!(
            crate::mdfacet::emphasis_spans("The fix for bug_004 landed, so bug_004 closed.\n")
                .is_empty()
        );
    }

    // Asterisk intraword emphasis is deliberate, so a `*` welded into a word is
    // exempt — even the `bug*004 … bug*004` corruption the rule once caught. The
    // two literal asterisks still pair into one run; the rule declines to report
    // it, the trade that lets the intended `**A**ffirmo` bolds below pass too.
    #[test]
    fn intraword_asterisk_identifier_emits_nothing() {
        let findings = check("The fix for bug*004 landed last week, so bug*004 is closed.\n");
        assert_eq!(findings.len(), 0);
        // The run forms — the exemption is the rule's, not the parser's.
        assert!(
            !crate::mdfacet::emphasis_spans(
                "The fix for bug*004 landed last week, so bug*004 is closed.\n"
            )
            .is_empty()
        );
    }

    // The live-vault false positive the underscore scoping retires: a bolded
    // word-initial letter (the `A`/`E`/`I`/`O` of `Affirmo`/`nEgo`). The closing
    // `**` welds onto `ffirmo`, which the old delimiter-agnostic weld flagged.
    #[test]
    fn word_initial_asterisk_bold_emits_nothing() {
        let findings = check("The mnemonic **A**ffirmo names the universal affirmative.\n");
        assert_eq!(findings.len(), 0);
        assert!(!crate::mdfacet::emphasis_spans("The mnemonic **A**ffirmo names it.\n").is_empty());
    }

    // Mid-word emphasis welds on BOTH sides, and is deliberate all the same.
    #[test]
    fn mid_word_asterisk_bold_emits_nothing() {
        let findings = check("It was un**be**lievable how fast super**cali**fragilistic parsed.\n");
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn dunder_identifier_emits_one_finding_each() {
        let findings = check("Both __init__ and __main__ are dunder names.\n");
        assert_eq!(findings.len(), 2);
        assert_eq!(findings[0].data.as_ref().unwrap()["text"], "__init__");
        assert_eq!(findings[1].data.as_ref().unwrap()["text"], "__main__");
    }

    #[test]
    fn singly_wrapped_identifier_emits_nothing() {
        // `_start_line_` is indistinguishable from the italic oxfmt writes, so it
        // stays silent — the doubled `__…__` spelling is the one that betrays a
        // literal underscore.
        let findings = check("Compare _start_line_ against the parsed value.\n");
        assert_eq!(findings.len(), 0);
    }

    // Box 6 — a placeholder run of repeated underscores used twice.
    //
    // Space-delimited `___` is inert for the same reason as `bug_004`: a `_` run
    // flanked by whitespace is neither left- nor right-flanking, so it opens
    // nothing and renders literally. Flanked by punctuation it pairs, and that is
    // the shape that actually corrupts.
    #[test]
    fn space_flanked_placeholder_run_is_never_emphasis() {
        let findings = check("Fill in ___ with the host and ___ with the port.\n");
        assert_eq!(findings.len(), 0);
        assert!(crate::mdfacet::emphasis_spans("Fill in ___ and ___ later.\n").is_empty());
    }

    #[test]
    fn punctuation_flanked_placeholder_run_emits_one_finding() {
        let findings = check("Use [___] and [___] as masks.\n");
        // `[___] and [___` is an `Emph` wrapping a `Strong`; the nested run is
        // dropped so one authored hazard yields one finding.
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].file, PathBuf::from("/vault/Foo.md"));
        let data = findings[0].data.as_ref().unwrap();
        assert_eq!(data["line"], 1);
        assert_eq!(data["shape"], "identifier-or-placeholder");
        assert_eq!(data["text"], "___] and [___");
    }

    #[test]
    fn asterisk_placeholder_run_emits_one_finding() {
        let findings = check("Use (***) for host and (***) for port.\n");
        assert_eq!(findings.len(), 1);
        assert_eq!(
            findings[0].data.as_ref().unwrap()["shape"],
            "identifier-or-placeholder"
        );
    }

    // A path or a filename INSIDE a well-framed run is intended bold or italic —
    // the delimiters are framed by whitespace and only the payload mentions a
    // file. 168 runs across the vault carry path-shaped content; flagging on that
    // content is what `is_glob_or_path` declines to do.
    #[test]
    fn a_path_inside_well_framed_emphasis_emits_nothing() {
        let findings = check("See **src/main.rs** for the entry point.\n");
        assert_eq!(findings.len(), 0);
    }

    // The second clause is the one a content test breaks: `**settings.json**` is
    // welded shut by the sentence period, so a predicate that accepts ONE welded
    // end plus an extension in the content flags it. See `is_glob_or_path`.
    #[test]
    fn a_filename_inside_well_framed_emphasis_emits_nothing() {
        let findings = check("Open the *config.toml* file now, then **settings.json**.\n");
        assert_eq!(findings.len(), 0);
    }

    // The form `oxfmt` normalizes every intended italic into. Flagging it would
    // fire on 405 runs across the vault.
    #[test]
    fn single_underscore_italic_emits_nothing() {
        let findings = check("This is _really_ important, and __init__ is not.\n");
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].data.as_ref().unwrap()["text"], "__init__");
    }

    #[test]
    fn a_doublestar_glob_emits_one_finding() {
        // The close welds on the trailing `/` of `src/**/*.js`, the open on the
        // leading `/` of the run's own content.
        let findings = check("Match **/*.ts and src/**/*.js in the config.\n");
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].data.as_ref().unwrap()["shape"], "glob-or-path");
    }

    #[test]
    fn a_glob_in_a_table_cell_is_reached() {
        let findings = check("| a | b |\n| --- | --- |\n| x \\| y | src/*.ts and dist/*.js |\n");
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].data.as_ref().unwrap()["line"], 3);
    }

    // Everything below is a shape the vault actually contains that must stay
    // silent. Each one fired under an earlier, looser predicate set; together
    // they are why the glob test is a conjunction over both delimiters.

    #[test]
    fn an_either_or_construction_around_a_slash_emits_nothing() {
        let findings = check(
            "The boundary shifts from auto/**human** to auto/**curated**, and it rejected _codex_/_vellum_ outright.\n",
        );
        assert_eq!(findings.len(), 0);
    }

    // The bug this ticket fixes: an either-or construction whose open already
    // welds on a real `/` must not be rescued by a trailing sentence period on
    // the close. `after == '.'` alone used to weld the close unconditionally, so
    // `auto/**human**.` — the same construction as above, now ending a sentence —
    // misfired. The three cases below pin the distinction the fix draws: a `.`
    // at end of input, a `.` before the next sentence, and a `.` immediately
    // welded to an extension (the genuine-path case, which must keep flagging).
    #[test]
    fn an_either_or_construction_ending_a_sentence_at_end_of_input_emits_nothing() {
        let findings = check("The split runs auto/**human**.");
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn an_either_or_construction_ending_a_sentence_before_more_prose_emits_nothing() {
        let findings = check("The split runs auto/**human**. Then it repeats.\n");
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn a_path_with_an_extension_after_the_close_still_flags() {
        let findings = check("The generated file is src/**foo**.md today.\n");
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].data.as_ref().unwrap()["shape"], "glob-or-path");
    }

    #[test]
    fn a_bolded_slash_command_emits_nothing() {
        let findings =
            check("**/experiment claim:** the packer abstains.\n\n**/goal (outer framing).**\n");
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn a_sentence_period_after_emphasis_emits_nothing() {
        let findings = check("The result was *really*. Then it was **not**.\n");
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn a_ratio_inside_emphasis_emits_nothing() {
        let findings = check("Confidence **10/10 ✅** on that one, **167/0** overall.\n");
        assert_eq!(findings.len(), 0);
    }

    // The three runs a one-welded-end predicate with a path-shaped-content test
    // would flag, and the reason it was rejected: a word-over-word alternation
    // closed by a sentence period is indistinguishable, by content, from a
    // two-component relative path.
    #[test]
    fn a_word_alternation_closed_by_a_sentence_period_emits_nothing() {
        let findings = check(
            "The Card/Note division relocated to **Track/Checkpoint**.\n\nGhostty: **Zig core + Swift/AppKit GUI**.\n\nIt targets _content_ suppression, not _style/structure_.\n",
        );
        assert_eq!(findings.len(), 0);
    }

    // The conjunction's one known miss, recorded rather than closed: a trailing
    // literal `*` after a filename leaves the close unwelded, so the pair of
    // literal asterisks renders as italic and goes unreported. Reaching it needs a
    // content test, which costs `**settings.json**.` above.
    #[test]
    fn a_trailing_asterisk_after_a_filename_is_a_known_miss() {
        let findings = check("Compare src/*.ts to the file main.ts* here.\n");
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn a_literal_placeholder_marker_emits_one_finding() {
        let findings = check("The revise pass echoed [__G0__] block markers into the glossary.\n");
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].data.as_ref().unwrap()["text"], "__G0__");
    }

    #[test]
    fn globs_inside_a_fenced_code_block_emit_nothing() {
        let findings = check("```sh\nrm src/*.ts and dist/*.js\n```\n");
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn globs_inside_an_indented_code_block_emit_nothing() {
        let findings = check("text\n\n    rm src/*.ts and dist/*.js\n");
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn identifier_inside_a_wikilink_emits_nothing() {
        let findings = check("See [[__init__]] for the constructor.\n");
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn frontmatter_offsets_do_not_shift_the_line() {
        let findings = check("---\ntype: card\n---\n\nDelete src/*.ts and dist/*.js now.\n");
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].data.as_ref().unwrap()["line"], 5);
    }

    #[test]
    fn a_glob_in_a_heading_or_a_list_is_reached() {
        let findings = check("# Clean src/*.ts and dist/*.js\n\n- also src/*.ts and dist/*.js\n");
        assert_eq!(findings.len(), 2);
        assert_eq!(findings[0].data.as_ref().unwrap()["line"], 1);
        assert_eq!(findings[1].data.as_ref().unwrap()["line"], 3);
    }

    #[test]
    fn a_long_run_is_quoted_truncated() {
        let filler = "x".repeat(120);
        let findings = check(&format!("Delete src/*.ts {filler} dist/*.js now.\n"));
        assert_eq!(findings.len(), 1);
        let quoted = findings[0].data.as_ref().unwrap()["text"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(quoted.chars().count(), QUOTE_CAP + 1);
        assert!(quoted.ends_with('…'), "quote was {quoted:?}");
    }

    #[test]
    fn empty_file_emits_nothing() {
        assert_eq!(check("").len(), 0);
    }
}
