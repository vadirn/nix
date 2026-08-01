//! Thin CLI over the `mdformat` crate. Three verbs:
//!   fixpoint   parse each input under mdstruct's shared comrak config, tile
//!              it with its top-level block spans, and report whether those
//!              spans partition the file's content bytes and reproduce it.
//!   normalize  report what the blank-line normal form would do to each input,
//!              and refuse any rewrite that changes the parse.
//!   pad        report what table padding would do to each input, and refuse
//!              any rewrite that changes the parse or moves a non-whitespace
//!              byte outside a delimiter row.
//!
//! Like `mdstruct check`, this takes paths and walks no directories: the
//! corpus run is a shell pipeline, and `-` reads stdin.
//!
//! **No verb writes a file.** `normalize` and `pad` are opt-in, report by
//! default, and emit bytes only to stdout under `--emit`; whether a rewrite may
//! ever be applied in place is an undecided policy question, so this binary has
//! no code that opens a file for writing.
//!
//! Exit codes: 0 pass, 1 I/O error, 3 input not UTF-8, 4 a file failed the
//! partition or reassembly check — or, under `normalize`, its rewrite failed
//! the structural-equivalence guard — 5 a sourcepos did not name a byte range.

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
    /// unpadded. Writes no file: this reports, and `--emit` prints the padded
    /// bytes of a single input to stdout.
    Pad(PadArgs),
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
        Commands::Fixpoint(args) => run_fixpoint(&args),
        Commands::Normalize(args) => run_normalize(&args),
        Commands::Pad(args) => run_pad(&args),
    };
    ExitCode::from(exit)
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

/// A gap's bytes on one line: newlines and tabs escaped, quoted.
fn escape(s: &str) -> String {
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
