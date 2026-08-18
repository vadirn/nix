//! `unintended-emphasis` — flags an emphasis run whose delimiters read as
//! literal text: two globs, a doubled-underscore identifier, a repeated fill-in
//! blank.
//!
//! CommonMark pairs two literal `*` in one paragraph into emphasis whenever the
//! first is left-flanking and the second right-flanking, which a glob supplies
//! for free: the `*` in `src/*.ts` sits between two punctuation characters. So
//! `src/*.ts and dist/*.js` renders as italic before any tool touches it.
//!
//! No test separates a literal glob asterisk from an intended marker, so this
//! rule reports and never rewrites.

use crate::commands::lint::rule::{Finding, LintContext, Rule, Severity};
use crate::mdfacet::EmphasisSpan;

/// Longest run quoted back in a finding. A span can cover most of a paragraph,
/// since the paired delimiters may sit sentences apart.
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
/// Reads the characters flanking each delimiter, never the content: `**src/main.rs**`
/// is ordinary bold that happens to name a file. A delimiter is welded when path
/// punctuation abuts it, and BOTH must be welded — one welded end alone is the
/// ordinary either-or construction (`auto/**human**`), while a glob welds both by
/// construction, opening after a `/` onto a `.` and closing on a `/`.
///
/// A closing `.` welds only when an alphanumeric follows it, as in the `md` of
/// `**foo**.md`. Otherwise it is the full stop ending `auto/**human**.`, whose open
/// already welds on the `/`, so the conjunction alone cannot save it.
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
/// - A delimiter run of three or more (`___`, `***`). Emphasis needs one or two.
/// - Bare-identifier content under a DOUBLED `_` (`__init__`). The doubling carries
///   the tell: `oxfmt` writes every intended italic as `_x_` and every bold as
///   `**x**`, so `__x__` is a spelling it never produces.
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

    #[test]
    fn globs_inside_a_code_span_emit_nothing() {
        let findings = check("Delete `rm src/*.ts and dist/*.js` before rebuilding.\n");
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn escaped_globs_emit_nothing() {
        let findings = check("Delete src/\\*.ts and dist/\\*.js before rebuilding.\n");
        assert_eq!(findings.len(), 0);
    }

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

    // CommonMark forbids an intraword `_` from opening or closing a run, so this
    // parses to no emphasis at all and there is no hazard to report. The `*`
    // spelling carries no such restriction and is flagged.
    #[test]
    fn underscore_identifier_twice_is_never_emphasis() {
        let findings = check("The fix for bug_004 landed last week, so bug_004 is closed.\n");
        assert_eq!(findings.len(), 0);
        assert!(
            crate::mdfacet::emphasis_spans("The fix for bug_004 landed, so bug_004 closed.\n")
                .is_empty()
        );
    }

    // CommonMark enables intraword `*` emphasis, so a `*` welded into a word is
    // exempt. The two literal asterisks still pair into one run; declining to
    // report it is what lets the intended `**A**ffirmo` bolds below pass.
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

    // A bolded word-initial letter: the closing `**` welds onto `ffirmo`.
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

    // A `_` run flanked by whitespace is neither left- nor right-flanking, so it
    // opens nothing. Flanked by punctuation it pairs, which is the corrupting shape.
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

    // A path INSIDE a well-framed run is intended bold: the delimiters are framed
    // by whitespace and only the payload mentions a file.
    #[test]
    fn a_path_inside_well_framed_emphasis_emits_nothing() {
        let findings = check("See **src/main.rs** for the entry point.\n");
        assert_eq!(findings.len(), 0);
    }

    // `**settings.json**` is welded shut by the sentence period, so accepting ONE
    // welded end would flag it.
    #[test]
    fn a_filename_inside_well_framed_emphasis_emits_nothing() {
        let findings = check("Open the *config.toml* file now, then **settings.json**.\n");
        assert_eq!(findings.len(), 0);
    }

    // The form `oxfmt` normalizes every intended italic into.
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

    // Shapes that must stay silent. Together they are why the glob test is a
    // conjunction over both delimiters.

    #[test]
    fn an_either_or_construction_around_a_slash_emits_nothing() {
        let findings = check(
            "The boundary shifts from auto/**human** to auto/**curated**, and it rejected _codex_/_vellum_ outright.\n",
        );
        assert_eq!(findings.len(), 0);
    }

    // An either-or construction whose open welds on a real `/` must not be rescued
    // by a trailing sentence period. The three cases pin the distinction: a `.` at
    // end of input, a `.` before the next sentence, and a `.` welded to an
    // extension, which must keep flagging.
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
