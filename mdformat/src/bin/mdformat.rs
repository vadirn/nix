//! Thin CLI over the `mdformat` crate. One verb so far:
//!   fixpoint   parse each input under mdstruct's shared comrak config, tile
//!              it with its top-level block spans, and report whether those
//!              spans partition the file's content bytes and reproduce it.
//!
//! Like `mdstruct check`, this takes paths and walks no directories: the
//! corpus run is a shell pipeline, and `-` reads stdin.
//!
//! Exit codes: 0 pass, 1 I/O error, 3 input not UTF-8, 4 a file failed the
//! partition or reassembly check, 5 a sourcepos did not name a byte range.

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
}

#[derive(Args)]
struct FixpointArgs {
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
        Commands::Fixpoint(args) => run_fixpoint(&args),
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
