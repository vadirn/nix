//! Thin CLI over the `mdformat` crate. Four verbs:
//!   format     apply every rewriting rule in one pass and print the result, or
//!              under `--check` report which inputs are not in normal form and
//!              where. A CRLF or lone-CR input is reported as departing, and
//!              formatted to LF throughout.
//!   fixpoint   parse each input under mdstruct's shared comrak config, tile
//!              it with its top-level block spans, and report whether those
//!              spans partition the file's content bytes and reproduce it.
//!   normalize  report what the blank-line normal form would do to each input,
//!              and refuse any rewrite that changes the parse.
//!   pad        report what table padding would do to each input, and refuse
//!              any rewrite that changes the parse or moves a non-whitespace
//!              byte outside a delimiter row.
//!
//! `format` is the product verb and the other three are diagnostic, which is
//! why they take opposite defaults: `format` prints bytes unless asked to
//! report, `normalize` and `pad` report unless asked for bytes (`--emit`).
//! Nothing has to chain the diagnostic verbs through stdout to get every rule
//! applied — that is what `format` is for.
//!
//! **Two rules have no verb of their own.** The endings rule has no guard to
//! dry-run and no corpus exposure to measure, so a verb would be unearned. The
//! marker rule has a guard, and it still has none: `format --check --verbose`
//! already reports every departure and every declined construct **tagged with
//! the rule that found it**, which is the whole of what a `markers` dry run
//! would print. `normalize` and `pad` predate that reporting — they are the
//! instruments that produced the corpus measurements those two rules are
//! argued from — and they stay; a new rule does not earn a fifth verb that
//! duplicates an existing one.
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
//! document, and each construct a rule left verbatim inside it. `--verbose`
//! adds nothing to it.
//!
//! Exit codes: 0 pass, 1 I/O error, 2 an invocation this refuses — a flag
//! combination, or a `--write` target that is not one regular file — 3 input
//! not UTF-8, 4 a file failed a check — the partition or reassembly check under
//! `fixpoint`, the structural-equivalence guard under `normalize` and `pad`,
//! normal form under `format --check` — 5 a sourcepos did not name a byte
//! range. `--write` writes nothing on any code but 0.
//!
//! A rule **declining** a document is not a failure and does not set an exit
//! code: the stage passes its input through, `format --check` reports the
//! document as normal, and the two agree because they read the same field.

use std::io::{self, Read};
use std::process::ExitCode;

use clap::{Args, Parser, Subcommand};
use mdformat::{LineIndex, Violation, escape_whitespace as escape};

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
    /// exiting 4 when any is not. Under `--write`, rewrite one named file in
    /// place instead of printing; both other modes leave every file alone.
    Format(FormatArgs),
    /// Verify each input is a fixpoint of the block-level passthrough printer:
    /// every non-whitespace byte in exactly one top-level block span, no
    /// overlaps, nothing past the end, and the reassembly equal to the input.
    Fixpoint(FixpointArgs),
    /// Report what blank-line normalization would do — one blank line between
    /// top-level blocks, one after front matter, one trailing newline, no
    /// trailing whitespace on a blank line. Writes no file: this reports, and
    /// `--emit` prints the normalized bytes of a single input to stdout.
    Normalize(NormalizeArgs),
    /// Report what table padding would do — every cell padded to its column's
    /// terminal display width, alignment markers preserved, the delimiter row
    /// widened to match, and a trailing unaligned or left-aligned column left
    /// unpadded with its delimiter cell sized to the header above it. Writes no
    /// file: this reports, and `--emit` prints the padded bytes of a single
    /// input to stdout.
    Pad(PadArgs),
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
    /// Also report what each rule declined — whole documents, and the
    /// individual constructs left verbatim inside them.
    #[arg(short, long)]
    verbose: bool,
    /// Rewrite the file in place, atomically, instead of printing to stdout,
    /// and report everything the rules declined. Takes exactly one path a
    /// person typed: two paths, a directory, a glob, or stdin is refused.
    /// Writes nothing when the file is already in normal form, and nothing at
    /// all when any rule errors.
    #[arg(short, long)]
    write: bool,
}

#[derive(Args)]
struct FixpointArgs {
    /// Input files; `-` reads stdin. With no path given, reads stdin.
    files: Vec<String>,
    /// Report each passing file too, with its block and byte counts.
    #[arg(short, long)]
    verbose: bool,
}

#[derive(Args)]
struct NormalizeArgs {
    /// Input files; `-` reads stdin. With no path given, reads stdin.
    files: Vec<String>,
    /// Print the normalized bytes to stdout instead of a report. Refuses more
    /// than one input, since concatenating two documents is not a formatting
    /// operation, and refuses any input whose rewrite fails the guard.
    #[arg(short, long)]
    emit: bool,
    /// Report each changed gap, with the bytes it holds now and the separator
    /// the normal form would put there.
    #[arg(short, long)]
    verbose: bool,
}

#[derive(Args)]
struct PadArgs {
    /// Input files; `-` reads stdin. With no path given, reads stdin.
    files: Vec<String>,
    /// Print the padded bytes to stdout instead of a report. Refuses more than
    /// one input, and refuses any input whose rewrite fails a guard.
    #[arg(short, long)]
    emit: bool,
    /// Report each changed line, and each table this declines to pad.
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
        Commands::Fixpoint(args) => run_fixpoint(&args),
        Commands::Normalize(args) => run_normalize(&args),
        Commands::Pad(args) => run_pad(&args),
    };
    ExitCode::from(exit)
}

/// Apply every rule in one pass, or report what stands between each input and
/// normal form.
///
/// The two modes read the same predicate, so they cannot disagree: a rule that
/// declines a document yields that document unchanged, which is exactly what
/// makes `--check` call it normal. A declination is therefore reported as an
/// exemption and sets no exit code.
///
/// The only thing this ever writes is stdout, and only without `--check`.
/// `--write` never reaches this function: it is a different verb wearing a
/// flag, and its whole point is that it does not loop over a file list.
fn run_format(args: &FormatArgs) -> u8 {
    if args.write {
        return run_write(args);
    }
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
            let result = match mdformat::check(source, &opts) {
                Ok(r) => r,
                Err(errors) => {
                    for e in &errors {
                        eprintln!("mdformat: {path}: SOURCEPOS ERROR: {e}");
                    }
                    exit = exit.max(5);
                    continue;
                }
            };
            declinations += result.declined().count();
            exemptions += result.exempt().count();
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
            if args.verbose {
                for (rule, why) in result.declined() {
                    eprintln!(
                        "mdformat: {path}: EXEMPT: the {rule} rule declined this document: {why}"
                    );
                }
                for (rule, e) in result.exempt() {
                    eprintln!("mdformat: {path}: EXEMPT: L{}: {rule}: {}", e.line, e.why);
                }
            }
            continue;
        }

        let result = match mdformat::format(source, &opts) {
            Ok(r) => r,
            Err(errors) => {
                for e in &errors {
                    eprintln!("mdformat: {path}: SOURCEPOS ERROR: {e}");
                }
                exit = exit.max(5);
                continue;
            }
        };
        declinations += result.declined().count();
        exemptions += result.exempt().count();
        if result.changed {
            changed += 1;
        } else {
            normal += 1;
        }
        // Reported unconditionally: stdout carries only bytes, so a stage that
        // passed its input through is invisible there, and a caller taking the
        // output would otherwise not learn the format is partial.
        for (rule, why) in result.declined() {
            eprintln!("mdformat: {path}: EXEMPT: the {rule} rule declined this document: {why}");
        }
        if args.verbose {
            for (rule, e) in result.exempt() {
                eprintln!("mdformat: {path}: EXEMPT: L{}: {rule}: {}", e.line, e.why);
            }
        }
        print!("{}", result.output);
    }

    if args.check {
        eprintln!(
            "mdformat format --check: {normal}/{files_checked} files are in normal form \
             ({departures} departures, {declinations} rule declinations, \
             {exemptions} exempt constructs)"
        );
    } else {
        eprintln!(
            "mdformat format: {changed}/{files_checked} files changed \
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

    // Unconditional, and not behind `--verbose`: a person reading the rewritten
    // file is the reason this tier exists, and what the rules left verbatim is
    // invisible in the result. `--verbose` therefore adds nothing here.
    //
    // The line numbers address the **rewritten** file, not the file as it was.
    // That falls out of the pipeline rather than being arranged: only `tables`
    // and `markers` exempt individual constructs, `gaps` is the one rule that
    // can move a line, and it runs before both of them. Which is the useful way
    // round — the report names lines in the file about to be opened.
    let declinations = report_declinations(&display, &result);

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
/// verbatim, and return the counts as the summary line words them.
fn report_declinations(display: &str, result: &mdformat::Format) -> String {
    let mut rules = 0usize;
    for (rule, why) in result.declined() {
        rules += 1;
        eprintln!("mdformat: {display}: EXEMPT: the {rule} rule declined this document: {why}");
    }
    let mut constructs = 0usize;
    for (rule, e) in result.exempt() {
        constructs += 1;
        eprintln!(
            "mdformat: {display}: EXEMPT: L{}: {rule}: {}",
            e.line, e.why
        );
    }
    format!("{rules} rule declinations, {constructs} exempt constructs")
}

fn run_fixpoint(args: &FixpointArgs) -> u8 {
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
        let report = match mdformat::fixpoint(source, &opts) {
            Ok(r) => r,
            Err(errors) => {
                for e in &errors {
                    eprintln!("mdformat: {path}: SOURCEPOS ERROR: {e}");
                }
                exit = exit.max(5);
                continue;
            }
        };

        content_bytes += report.partition.content_bytes;
        covered_bytes += report.partition.covered_content_bytes;
        blocks += report.partition.blocks;
        synthetic += report
            .blocks
            .iter()
            .filter(|b| b.sourcepos.is_none())
            .count();

        if report.passed() {
            files_ok += 1;
            if args.verbose {
                eprintln!(
                    "mdformat: {path}: ok ({} blocks, {} content bytes)",
                    report.partition.blocks, report.partition.content_bytes
                );
            }
            continue;
        }

        exit = exit.max(4);
        let idx = LineIndex::new(source);
        for v in &report.partition.violations {
            eprintln!("mdformat: {path}: FAIL: {}", describe(source, &idx, v));
        }
        if !report.matches_input {
            let at = first_difference(source, &report.output);
            let (line, col) = idx.position_of(at.min(source.len()));
            eprintln!(
                "mdformat: {path}: FAIL: reassembly differs from input at byte {at} (L{line}:{col}): {}",
                context(source, at, at)
            );
        }
    }

    eprintln!(
        "mdformat fixpoint: {files_ok}/{files_checked} files pass \
         ({covered_bytes}/{content_bytes} content bytes in exactly one block span, \
         {blocks} blocks, {synthetic} of them synthetic)"
    );
    exit
}

/// Report what blank-line normalization would do, and refuse anything the
/// structural-equivalence guard rejects.
///
/// The only thing this ever writes is stdout, and only under `--emit`. A
/// corpus run over the vault is therefore a read-only operation by
/// construction, not by convention.
fn run_normalize(args: &NormalizeArgs) -> u8 {
    let files = resolve(&args.files);
    if args.emit && files.len() > 1 {
        eprintln!(
            "mdformat: normalize --emit takes exactly one input, got {}",
            files.len()
        );
        return 2;
    }
    let opts = mdstruct::Options::default();
    let mut exit: u8 = 0;
    let mut files_checked = 0usize;
    let mut would_change = 0usize;
    let mut refused = 0usize;
    let mut skipped = 0usize;
    let mut gaps_considered = 0usize;
    let mut gaps_changed = 0usize;

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
        let result = match mdformat::normalize(source, &opts) {
            Ok(r) => r,
            Err(errors) => {
                for e in &errors {
                    eprintln!("mdformat: {path}: SOURCEPOS ERROR: {e}");
                }
                exit = exit.max(5);
                continue;
            }
        };
        gaps_considered += result.gaps_considered;
        gaps_changed += result.gaps.len();

        if !result.input_partition.is_partition() {
            // The gap between two blocks is whitespace *because* the partition
            // says no content is unclaimed. Without that, normalizing would be
            // guessing which bytes are separators.
            skipped += 1;
            exit = exit.max(4);
            eprintln!(
                "mdformat: {path}: SKIP: the input fails the partition oracle \
                 ({} violations), so its gaps are not defined",
                result.input_partition.violations.len()
            );
            continue;
        }

        if let Some(diff) = &result.structure {
            refused += 1;
            exit = exit.max(4);
            eprintln!("mdformat: {path}: REFUSED: normalizing changes the parse: {diff}");
            if result.output_partitions == Some(true) {
                eprintln!(
                    "mdformat: {path}: note: the refused output still satisfies the \
                     partition oracle — only re-parse equivalence catches this"
                );
            }
            continue;
        }

        if result.changed() {
            would_change += 1;
            eprintln!(
                "mdformat: {path}: would change ({} of {} gaps)",
                result.gaps.len(),
                result.gaps_considered
            );
            if args.verbose {
                let idx = LineIndex::new(source);
                for g in &result.gaps {
                    let (line, col) = idx.position_of(g.start);
                    eprintln!(
                        "mdformat: {path}: L{line}:{col} {} -> {}: {} => {}",
                        g.prev,
                        g.next,
                        escape(&g.old),
                        escape(g.new)
                    );
                }
            }
        }

        if args.emit {
            match result.accepted() {
                Some(out) => print!("{out}"),
                // Unreachable given the two guards above; kept because
                // `accepted` is the only sanctioned way to reach the bytes and
                // this must not become a second one.
                None => {
                    eprintln!("mdformat: {path}: refusing to emit an unguarded rewrite");
                    exit = exit.max(4);
                }
            }
        }
    }

    eprintln!(
        "mdformat normalize: {would_change}/{files_checked} files would change \
         ({refused} refused by the structure guard, {skipped} skipped for a failing \
         partition, {gaps_changed}/{gaps_considered} gaps rewritten)"
    );
    exit
}

/// Report what table padding would do, and refuse anything either guard
/// rejects.
///
/// Like `normalize`, the only thing this ever writes is stdout, and only under
/// `--emit`.
fn run_pad(args: &PadArgs) -> u8 {
    let files = resolve(&args.files);
    if args.emit && files.len() > 1 {
        eprintln!(
            "mdformat: pad --emit takes exactly one input, got {}",
            files.len()
        );
        return 2;
    }
    let opts = mdstruct::Options::default();
    let mut exit: u8 = 0;
    let mut files_checked = 0usize;
    let mut would_change = 0usize;
    let mut refused = 0usize;
    let mut skipped_files = 0usize;
    let mut tables_seen = 0usize;
    let mut tables_changed = 0usize;

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
        let result = match mdformat::pad(source, &opts) {
            Ok(r) => r,
            Err(errors) => {
                for e in &errors {
                    eprintln!("mdformat: {path}: SOURCEPOS ERROR: {e}");
                }
                exit = exit.max(5);
                continue;
            }
        };
        tables_seen += result.tables_seen;
        tables_changed += result.tables_changed;

        if !result.skipped.is_empty() {
            skipped_files += 1;
            for s in &result.skipped {
                eprintln!(
                    "mdformat: {path}: SKIP: the table at line {} is left verbatim: {}",
                    s.line, s.reason
                );
            }
        }

        // The partition is reported, never gated on: this rewrite is defined by
        // row sourcepos and whole-line ranges, so unlike a gap rewrite it does
        // not need the partition to know which bytes are separators.
        if !result.input_partition.is_partition() {
            eprintln!(
                "mdformat: {path}: note: the input fails the partition oracle \
                 ({} violations); padding does not depend on it",
                result.input_partition.violations.len()
            );
        }

        if let Some(diff) = &result.structure {
            refused += 1;
            exit = exit.max(4);
            eprintln!("mdformat: {path}: REFUSED: padding changes the parse: {diff}");
            continue;
        }
        if let Some(v) = &result.violation {
            refused += 1;
            exit = exit.max(4);
            eprintln!("mdformat: {path}: REFUSED: padding moved more than whitespace: {v}");
            continue;
        }

        if result.changed() {
            would_change += 1;
            eprintln!(
                "mdformat: {path}: would change ({} of {} tables, {} lines)",
                result.tables_changed,
                result.tables_seen,
                result.changes.len()
            );
            if args.verbose {
                for c in &result.changes {
                    eprintln!(
                        "mdformat: {path}: L{}: {} => {}",
                        c.line,
                        escape(&c.old),
                        escape(&c.new)
                    );
                }
            }
        }

        if args.emit {
            match result.accepted() {
                Some(out) => print!("{out}"),
                // Unreachable given the two guards above; kept because
                // `accepted` is the only sanctioned way to reach the bytes.
                None => {
                    eprintln!("mdformat: {path}: refusing to emit an unguarded rewrite");
                    exit = exit.max(4);
                }
            }
        }
    }

    eprintln!(
        "mdformat pad: {would_change}/{files_checked} files would change \
         ({refused} refused by the guards, {skipped_files} skipped for a table this \
         cannot pad, {tables_changed}/{tables_seen} tables repadded)"
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

/// Byte offset of the first difference between the input and the printer's
/// output; the shorter length when one is a prefix of the other.
fn first_difference(a: &str, b: &str) -> usize {
    a.as_bytes()
        .iter()
        .zip(b.as_bytes())
        .position(|(x, y)| x != y)
        .unwrap_or_else(|| a.len().min(b.len()))
}
