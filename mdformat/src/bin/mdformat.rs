//! Thin CLI over the `mdformat` crate. Two verbs:
//!   format     apply every rewriting rule in one pass and print the result, or
//!              under `--check` report which inputs are not in normal form and
//!              where. A CRLF or lone-CR input is reported as departing, and
//!              formatted to LF throughout. `--rule <name>` narrows either mode
//!              to one rule.
//!   partition  parse each input under mdstruct's shared comrak config, tile
//!              it with its top-level block spans, and report whether those
//!              spans partition the file's content bytes.
//!
//! **This verb was called `fixpoint` until this commit.** The word was already
//! taken, and by something more central: `fixpoint` is one of the two clauses
//! of [`mdformat::format`]'s contract — `format(f) == f` for every `f` already
//! normal — asserted under that name across `tests/normal_form.rs`,
//! `tests/endings.rs` and `tests/table.rs`. A verb meaning "the block spans
//! partition the content bytes" had no claim on it. `corpus.sh` showed the
//! collision at its sharpest: its `--fixpoint-only` flag *skipped* the
//! idempotence phase, which is the phase that actually tests the fixpoint
//! clause. The verb now takes the name every string it prints already uses.
//!
//! **`--rule` is what two verbs used to be.** `normalize` and `pad` were dry
//! runs of the gap and table rules: each reported what its own rule would do,
//! and emitted that rule's bytes under `--emit`. `format --check --rule gaps`
//! is the first half and `format --rule gaps` the second — for all four rules
//! rather than for two of them, and without a second reporting path to keep in
//! step with `format`'s. The flag takes the name the report already tags a
//! departure with, resolved against `format::RULES` by
//! [`mdformat::rule_named`], so it cannot name a rule the reports do not, and
//! a fifth rule becomes selectable without an edit here.
//!
//! The one thing the verbs had that the flag does not is a **refusal**:
//! `normalize --emit` exited 4 rather than print bytes for a document whose
//! rewrite failed the structure guard. Under `format` that is not a failure —
//! the rule declines, yields its input, and the declination goes to stderr
//! while the input's own bytes go to stdout. That is this crate's settled
//! position on declinations (see [`mdformat::format`]); the verbs predate it,
//! and a dry run that exits 4 on a document `format` calls normal is the
//! disagreement, not the safeguard.
//!
//! **The corpus figures the module docs quote were measured with those verbs**,
//! last present at commit `333ac55`. The space and byte deltas in
//! [`mdformat::table`], the gap and blank-line-site counts in
//! [`mdformat::normalize`], and the front-matter clause withdrawn there for
//! costing 988 of 1052 files all come from batch runs of `mdformat normalize`
//! and `mdformat pad` over the vault corpus. Re-measuring any of them now means
//! `format --check --rule <name>` and its summary line, which counts one
//! departure per changed line: the same number `normalize` reported as a
//! rewritten gap, and `pad`'s changed-line count rather than its table count.
//!
//! **No rule has a verb of its own, and none needs one.** `format --check
//! --rule <name>` reports every departure and every declined construct for
//! exactly one rule, tagged with it, which is the whole of what a per-rule dry
//! run printed.
//!
//! Like `mdstruct check`, this takes paths and walks no directories: the
//! corpus run is a shell pipeline, and `-` reads stdin.
//!
//! **One flag writes a file: `format --write`, and it rewrites exactly one.**
//! Every other rewrite here is opt-in and reaches only stdout. `--write` takes
//! one path a person typed, and refuses two paths, a directory, a shell glob, or
//! stdin — see [`mdformat::write`], which holds the refusal and argues why it is
//! code and not a README. Rewriting a batch, or rewriting anything without a
//! person reading the result, is a separate tier this binary does not implement.
//!
//! Because that person is the reason the tier is allowed, `--write` reports
//! **every** declination without being asked: each rule that declined the
//! document, and each construct a rule left verbatim inside it.
//!
//! **So does every other mode of `format`, and it has no `--verbose` to ask
//! with.** That flag used to gate the per-construct half of the report — and
//! under `--check`, the whole-document half as well — which left the reporting
//! mode's default output silent about exactly the refusals this crate spends
//! its module docs arguing must be legible. Removing it costs close to nothing
//! in lines: over this repository's 380 tracked `.md` files the report it
//! gated is empty (zero declinations, zero exempt constructs), and over the
//! 1056-file vault corpus it is **one** line, a ragged table the `tables` rule
//! leaves verbatim. That is the whole price of never having to know to ask.
//!
//! `partition` keeps a `--verbose`, and it is a different flag doing a different
//! job: it reports each **passing** file, which is noise proportional to the
//! corpus rather than a refusal that would otherwise go unsaid.
//!
//! Exit codes: 0 pass, 1 I/O error, 2 an invocation this refuses — a flag
//! combination, an unknown `--rule` name, or a `--write` target that is not one
//! regular file — 3 input not UTF-8, 4 a file failed a check — the partition
//! under `partition`, normal form under `format --check` — 5 a sourcepos did not
//! name a byte range. `--write` writes nothing on any code but 0.
//!
//! A rule **declining** a document is not a failure and does not set an exit
//! code: the stage passes its input through, `format --check` reports the
//! document as normal, and the two agree because they read the same field.

use std::io::{self, Read};
use std::process::ExitCode;

use clap::{Args, Parser, Subcommand};
use mdformat::{LineIndex, Violation};

/// Comrak's parser plus mdstruct's shared parse configuration, with a
/// block-level passthrough printer over node sourcepos.
#[derive(Parser)]
#[command(
    name = "mdformat",
    version,
    about = "Markdown formatter sharing mdstruct's comrak parse configuration"
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Apply every rewriting rule — LF line endings, then blank-line gaps, then
    /// table padding, then list markers — in one pass and print the result to
    /// stdout. Under `--check`, print nothing
    /// and report instead which inputs are not in normal form and where,
    /// exiting 4 when any is not. Under `--rule`, do either for one rule alone.
    /// Under `--write`, rewrite one named file in place instead of printing;
    /// every other mode leaves every file alone.
    Format(FormatArgs),
    /// Verify each input's top-level block spans partition its content bytes:
    /// every non-whitespace byte in exactly one span, no overlaps, nothing past
    /// the end. That partition is what makes a block rewrite safe — it is the
    /// condition under which splicing over one block's range neither drops nor
    /// duplicates the rest of the file.
    Partition(PartitionArgs),
}

#[derive(Args)]
struct FormatArgs {
    /// Input files; `-` reads stdin. With no path given, reads stdin. Without
    /// `--check` this takes exactly one input, since concatenating two
    /// documents is not a formatting operation. Under `--write` it takes
    /// exactly one path, and neither stdin nor the no-path default.
    files: Vec<String>,
    /// Report which inputs depart from normal form, and where, instead of
    /// printing formatted bytes. Exits 4 when any input departs.
    #[arg(short, long)]
    check: bool,
    /// Run one rule instead of all four, named as the reports tag it: endings,
    /// gaps, tables, or markers. Prints that rule's output, or under `--check`
    /// reports only its departures. An unknown name is refused. Cannot be
    /// combined with `--write`, which rewrites a file to the whole normal form.
    #[arg(short, long, value_name = "NAME")]
    rule: Option<String>,
    /// Rewrite the file in place, atomically, instead of printing to stdout,
    /// and report everything the rules declined. Takes exactly one path a
    /// person typed: two paths, a directory, a glob, or stdin is refused.
    /// Writes nothing when the file is already in normal form, and nothing at
    /// all when any rule errors.
    #[arg(short, long)]
    write: bool,
}

#[derive(Args)]
struct PartitionArgs {
    /// Input files; `-` reads stdin. With no path given, reads stdin.
    files: Vec<String>,
    /// Report each passing file too, with its block and byte counts.
    #[arg(short, long)]
    verbose: bool,
}

/// An empty input list means "read stdin" (`-`). Mirrors `mdstruct check`'s
/// `resolve` exactly, so the two CLIs read a file list the same way.
fn resolve(files: &[String]) -> Vec<String> {
    if files.is_empty() {
        vec!["-".to_string()]
    } else {
        files.to_vec()
    }
}

fn read_stdin() -> io::Result<Vec<u8>> {
    let mut buf = Vec::new();
    io::stdin().read_to_end(&mut buf)?;
    Ok(buf)
}

/// Read one input by path (`-` = stdin). Returns (display-path, bytes) or the
/// exit code to accumulate on failure (1 = io).
fn read_input(f: &str) -> Result<(String, Vec<u8>), u8> {
    if f == "-" {
        match read_stdin() {
            Ok(b) => Ok(("-".to_string(), b)),
            Err(e) => {
                eprintln!("mdformat: stdin: {e}");
                Err(1)
            }
        }
    } else {
        match std::fs::read(f) {
            Ok(b) => Ok((f.to_string(), b)),
            Err(e) => {
                eprintln!("mdformat: {f}: {e}");
                Err(1)
            }
        }
    }
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let exit = match cli.command {
        Commands::Format(args) => run_format(&args),
        Commands::Partition(args) => run_partition(&args),
    };
    ExitCode::from(exit)
}

/// The rules one invocation runs: all of [`mdformat::format::RULES`], or the
/// single one `--rule` named.
///
/// The name is resolved against `RULES` rather than against a list kept here,
/// so this function needs no edit when a rule is added and cannot accept a name
/// no report prints. An unrecognized name is a refused invocation (exit 2), not
/// a silent fallback to every rule: a caller who asked for one rule and got
/// four would read a report about rules it did not ask about.
fn selected_rules(name: Option<&str>) -> Result<Vec<&'static dyn mdformat::Rule>, u8> {
    let Some(name) = name else {
        return Ok(mdformat::format::RULES.to_vec());
    };
    match mdformat::rule_named(name) {
        Some(rule) => Ok(vec![rule]),
        None => {
            eprintln!(
                "mdformat: no rule is named {name:?}; --rule takes one of: {}",
                mdformat::rule_names().collect::<Vec<_>>().join(", ")
            );
            Err(2)
        }
    }
}

/// Apply the selected rules in one pass, or report what stands between each
/// input and their normal form.
///
/// The two modes read the same predicate, so they cannot disagree: a rule that
/// declines a document yields that document unchanged, which is exactly what
/// makes `--check` call it normal. A declination is therefore reported as an
/// exemption and sets no exit code.
///
/// Both modes report every declination and every exempt construct
/// unconditionally. Under `--check` that is the only place a refusal appears at
/// all; without it, stdout carries bytes alone, so a stage that passed its
/// input through is invisible there and a caller taking the output would
/// otherwise not learn the format is partial.
///
/// The only thing this ever writes is stdout, and only without `--check`.
/// `--write` never reaches the loop below: it is a different verb wearing a
/// flag, and its whole point is that it does not loop over a file list.
fn run_format(args: &FormatArgs) -> u8 {
    let rules = match selected_rules(args.rule.as_deref()) {
        Ok(rules) => rules,
        Err(code) => return code,
    };
    if args.write {
        // `--write` rewrites a file to *the* normal form, which is every rule;
        // one rule's output is by construction not that, and the fixpoint
        // assertion guarding the write would refuse it a moment later with a
        // message about a rule interaction that is not what happened. Refuse
        // here instead, where the reason is the invocation.
        if args.rule.is_some() {
            eprintln!(
                "mdformat: --write rewrites a file to normal form, which is every rule; \
                 --rule runs one, so give it without --write to print or check that rule"
            );
            return 2;
        }
        return run_write(args);
    }
    // Named for the summary line, so a restricted run's totals cannot be read
    // as the whole normal form's.
    let scope = match args.rule.as_deref() {
        Some(name) => format!(" --rule {name}"),
        None => String::new(),
    };
    let files = resolve(&args.files);
    if !args.check && files.len() > 1 {
        eprintln!(
            "mdformat: format takes exactly one input unless --check is given, got {}",
            files.len()
        );
        return 2;
    }
    let opts = mdstruct::Options::default();
    let mut exit: u8 = 0;
    let mut files_checked = 0usize;
    let mut normal = 0usize;
    let mut changed = 0usize;
    let mut departures = 0usize;
    let mut declinations = 0usize;
    let mut exemptions = 0usize;

    for f in &files {
        let (path, bytes) = match read_input(f) {
            Ok(v) => v,
            Err(code) => {
                exit = exit.max(code);
                continue;
            }
        };
        let source = match std::str::from_utf8(&bytes) {
            Ok(s) => s,
            Err(_) => {
                eprintln!("mdformat: {path}: input is not valid UTF-8");
                exit = exit.max(3);
                continue;
            }
        };
        files_checked += 1;

        if args.check {
            let result = match mdformat::check_with(&rules, source, &opts) {
                Ok(r) => r,
                Err(errors) => {
                    for e in &errors {
                        eprintln!("mdformat: {path}: SOURCEPOS ERROR: {e}");
                    }
                    exit = exit.max(5);
                    continue;
                }
            };
            // Every rule runs against the input itself, so these positions
            // address the file as it is on disk and sorting them together is
            // meaningful.
            let mut found: Vec<_> = result.departures().collect();
            found.sort_by_key(|(_, d)| (d.line, d.column));
            departures += found.len();

            if result.is_normal() {
                normal += 1;
            } else {
                exit = exit.max(4);
                eprintln!("mdformat: {path}: NOT NORMAL ({} departures)", found.len());
                for (rule, d) in &found {
                    eprintln!(
                        "mdformat: {path}:L{}:{}: {rule}: {}",
                        d.line, d.column, d.what
                    );
                }
            }
            // The summary's two counts come back from the report that printed
            // them, so a line printed and a line counted are the same event.
            let (declined, exempt) = report_exemptions(&path, result.declined(), result.exempt());
            declinations += declined;
            exemptions += exempt;
            continue;
        }

        let result = match mdformat::format_with(&rules, source, &opts) {
            Ok(r) => r,
            Err(errors) => {
                for e in &errors {
                    eprintln!("mdformat: {path}: SOURCEPOS ERROR: {e}");
                }
                exit = exit.max(5);
                continue;
            }
        };
        if result.changed {
            changed += 1;
        } else {
            normal += 1;
        }
        let (declined, exempt) = report_exemptions(&path, result.declined(), result.exempt());
        declinations += declined;
        exemptions += exempt;
        print!("{}", result.output);
    }

    if args.check {
        eprintln!(
            "mdformat format --check{scope}: {normal}/{files_checked} files are in normal form \
             ({departures} departures, {declinations} rule declinations, \
             {exemptions} exempt constructs)"
        );
    } else {
        eprintln!(
            "mdformat format{scope}: {changed}/{files_checked} files changed \
             ({declinations} rule declinations, {exemptions} exempt constructs)"
        );
    }
    exit
}

/// Rewrite exactly one named file in place, and report everything the rules
/// left alone.
///
/// This is the only function in this binary that opens a file for writing, and
/// it is deliberately not a loop. `run_format`'s file list is a convenience for
/// reporting over a corpus; a rewrite over a corpus is a different act, gated on
/// conditions this program cannot check, so the single target is taken from
/// [`mdformat::write::target`] — which refuses two paths, a directory, a glob,
/// and stdin — rather than from `resolve`, whose "no paths means stdin"
/// defaulting is exactly what would let a bare `--write` pick its own target.
///
/// Nothing is written on any path but the last: a refused invocation, an
/// unreadable or non-UTF-8 file, a rule that errored, an already-normal
/// document, and an output that is not itself in normal form all leave the file
/// byte-identical.
fn run_write(args: &FormatArgs) -> u8 {
    if args.check {
        eprintln!(
            "mdformat: format --check reports and writes nothing, and --write rewrites \
             a file; give one or the other"
        );
        return 2;
    }
    let path = match mdformat::write::target(&args.files) {
        Ok(p) => p,
        Err(refusal) => {
            eprintln!("mdformat: {refusal}");
            return 2;
        }
    };
    let display = path.display().to_string();

    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("mdformat: {display}: {e}");
            return 1;
        }
    };
    let source = match std::str::from_utf8(&bytes) {
        Ok(s) => s,
        Err(_) => {
            eprintln!("mdformat: {display}: input is not valid UTF-8");
            return 3;
        }
    };

    let opts = mdstruct::Options::default();
    let result = match mdformat::format(source, &opts) {
        Ok(r) => r,
        Err(errors) => {
            for e in &errors {
                eprintln!("mdformat: {display}: SOURCEPOS ERROR: {e}");
            }
            eprintln!("mdformat: {display}: NOT REWRITTEN: a rule could not read this document");
            return 5;
        }
    };

    // A person reading the rewritten file is the reason this tier exists, and
    // what the rules left verbatim is invisible in the result — so it is said.
    //
    // The line numbers address the **rewritten** file, not the file as it was.
    // That falls out of the pipeline rather than being arranged: only `tables`
    // and `markers` exempt individual constructs, `gaps` is the one rule that
    // can move a line, and it runs before both of them. Which is the useful way
    // round — the report names lines in the file about to be opened.
    let (declined, exempt) = report_exemptions(&display, result.declined(), result.exempt());
    let declinations = format!("{declined} rule declinations, {exempt} exempt constructs");

    if !result.changed {
        eprintln!("mdformat: {display}: already in normal form, left untouched");
        eprintln!("mdformat format --write: 0/1 files rewritten ({declinations})");
        return 0;
    }

    // The last check before the one irreversible step. `format` is a retraction
    // onto a normal form, so its output must already be a fixpoint of `check`;
    // measured over this repository's 397 tracked markdown files, it is one for
    // every single file. This asserts it for *this* file, at the moment the
    // assertion is worth something, because a rule interaction that leaves the
    // output still departing would otherwise reach disk before anyone saw it.
    // Reaching this branch is a bug in a rule, not in the document.
    match mdformat::check(&result.output, &opts) {
        Ok(c) if !c.is_normal() => {
            let departures = c.departures().count();
            eprintln!(
                "mdformat: {display}: NOT REWRITTEN: the formatted output still departs \
                 from normal form in {departures} places, so this pass reached no fixpoint"
            );
            for (rule, d) in c.departures() {
                eprintln!(
                    "mdformat: {display}: would still be L{}:{}: {rule}: {}",
                    d.line, d.column, d.what
                );
            }
            return 4;
        }
        Ok(_) => {}
        Err(errors) => {
            for e in &errors {
                eprintln!("mdformat: {display}: SOURCEPOS ERROR: {e}");
            }
            eprintln!("mdformat: {display}: NOT REWRITTEN: the formatted output cannot be re-read");
            return 5;
        }
    }

    if let Err(e) = mdformat::write::replace(&path, &result.output) {
        eprintln!("mdformat: {display}: NOT REWRITTEN: {e}");
        return 1;
    }
    eprintln!(
        "mdformat: {display}: rewritten in place, {} bytes were {}",
        result.output.len(),
        source.len()
    );
    eprintln!("mdformat format --write: 1/1 files rewritten ({declinations})");
    0
}

/// Print every rule that declined the document and every construct a rule left
/// verbatim, and return the two counts.
///
/// The one reporting path for both, shared by every mode of `format` —
/// printing, `--check` and `--write` — so a refusal reads the same wherever it
/// is met, and no mode can grow a report the others lack. Nothing gates it: a
/// rule that left something alone is invisible in the bytes, so the only way to
/// learn of it is to be told, and a report that has to be asked for is one
/// nobody asks for.
fn report_exemptions<'a>(
    display: &str,
    declined: impl Iterator<Item = (&'static str, &'a str)>,
    exempt: impl Iterator<Item = (&'static str, &'a mdformat::Exemption)>,
) -> (usize, usize) {
    let mut rules = 0usize;
    for (rule, why) in declined {
        rules += 1;
        eprintln!("mdformat: {display}: EXEMPT: the {rule} rule declined this document: {why}");
    }
    let mut constructs = 0usize;
    for (rule, e) in exempt {
        constructs += 1;
        eprintln!(
            "mdformat: {display}: EXEMPT: L{}: {rule}: {}",
            e.line, e.why
        );
    }
    (rules, constructs)
}

fn run_partition(args: &PartitionArgs) -> u8 {
    let files = resolve(&args.files);
    let opts = mdstruct::Options::default();
    let mut exit: u8 = 0;
    let mut files_ok = 0usize;
    let mut files_checked = 0usize;
    let mut content_bytes = 0usize;
    let mut covered_bytes = 0usize;
    let mut blocks = 0usize;
    // Blocks no comrak node backs: a leading BOM, and the lines comrak deletes
    // as link reference definitions. Reported because each one is a byte range
    // claimed on a shape check rather than on a parser's say-so, and a rising
    // count is the signal that the check is doing more work than intended.
    let mut synthetic = 0usize;

    for f in &files {
        let (path, bytes) = match read_input(f) {
            Ok(v) => v,
            Err(code) => {
                exit = exit.max(code);
                continue;
            }
        };
        let source = match std::str::from_utf8(&bytes) {
            Ok(s) => s,
            Err(_) => {
                eprintln!("mdformat: {path}: input is not valid UTF-8");
                exit = exit.max(3);
                continue;
            }
        };

        files_checked += 1;
        let part = match mdformat::partition(source, &opts) {
            Ok(r) => r,
            Err(errors) => {
                for e in &errors {
                    eprintln!("mdformat: {path}: SOURCEPOS ERROR: {e}");
                }
                exit = exit.max(5);
                continue;
            }
        };

        content_bytes += part.report.content_bytes;
        covered_bytes += part.report.covered_content_bytes;
        blocks += part.report.blocks;
        synthetic += part.blocks.iter().filter(|b| b.sourcepos.is_none()).count();

        if part.passed() {
            files_ok += 1;
            if args.verbose {
                eprintln!(
                    "mdformat: {path}: ok ({} blocks, {} content bytes)",
                    part.report.blocks, part.report.content_bytes
                );
            }
            continue;
        }

        exit = exit.max(4);
        let idx = LineIndex::new(source);
        for v in &part.report.violations {
            eprintln!("mdformat: {path}: FAIL: {}", describe(source, &idx, v));
        }
    }

    eprintln!(
        "mdformat partition: {files_ok}/{files_checked} files pass \
         ({covered_bytes}/{content_bytes} content bytes in exactly one block span, \
         {blocks} blocks, {synthetic} of them synthetic)"
    );
    exit
}

/// One violation as a line naming the byte offset, the position, and the
/// source around it, so the cause is legible without reopening the file.
fn describe(source: &str, idx: &LineIndex, v: &Violation) -> String {
    match v {
        Violation::Uncovered { start, end } => {
            let (line, col) = idx.position_of(*start);
            format!(
                "uncovered content at byte {start} (L{line}:{col}), {} bytes: {} \
                 — no block span claims it",
                end - start,
                context(source, *start, *end)
            )
        }
        Violation::Overlap {
            start,
            end,
            depth,
            kinds,
        } => {
            let (line, col) = idx.position_of(*start);
            format!(
                "overlap at bytes {start}..{end} (L{line}:{col}), claimed {depth}x by {}: {}",
                kinds.join(", "),
                context(source, *start, *end)
            )
        }
        Violation::OutOfBounds {
            kind,
            start,
            end,
            len,
        } => format!("{kind} span {start}..{end} reaches past the end of the source ({len} bytes)"),
        Violation::Inverted { kind, start, end } => {
            format!("{kind} span {start}..{end} is inverted")
        }
    }
}

/// The source between `start` and `end` plus a little either side, quoted and
/// escaped so newlines and tabs stay on one line.
fn context(source: &str, start: usize, end: usize) -> String {
    const PAD: usize = 24;
    const CAP: usize = 120;
    let lo = floor_boundary(source, start.saturating_sub(PAD));
    let hi = ceil_boundary(source, (end + PAD).min(source.len()));
    let mut out = String::from("\"");
    if lo > 0 {
        out.push('…');
    }
    for c in source[lo..hi].chars().take(CAP) {
        match c {
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '"' => out.push_str("\\\""),
            c => out.push(c),
        }
    }
    if hi < source.len() {
        out.push('…');
    }
    out.push('"');
    out
}

fn floor_boundary(source: &str, mut i: usize) -> usize {
    i = i.min(source.len());
    while !source.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn ceil_boundary(source: &str, mut i: usize) -> usize {
    i = i.min(source.len());
    while !source.is_char_boundary(i) {
        i += 1;
    }
    i
}
