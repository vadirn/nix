//! Thin CLI over the mdstruct structural core. Three verbs, one parse each:
//!   (default)  parse → NDJSON on stdout (one JSON document per line)
//!   check      freeze gate → pass/fail summary on stderr, exit 4 on failure
//!   stats      type-coverage report on stdout
//! Each verb owns a stream contract; none crosses stdout with stderr.

use std::collections::BTreeMap;
use std::io::{self, Read, Write};
use std::process::ExitCode;

use clap::{Args, Parser, Subcommand};
use mdstruct::{Options, SCHEMA_VERSION, parse_bytes, verify_spans};

/// Markdown structural-parsing core → NDJSON.
///
/// Bare `mdstruct FILES...` parses to NDJSON; the `check` and `stats`
/// subcommands are different verbs riding on the same parse.
#[derive(Parser)]
#[command(
    name = "mdstruct",
    version,
    about = "Markdown structural-parsing core → NDJSON",
    args_conflicts_with_subcommands = true,
    after_help = TOP_AFTER_HELP,
    after_long_help = TOP_AFTER_LONG_HELP
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,

    #[command(flatten)]
    parse: ParseArgs,

    /// Print the schema contract version and exit (works with no files).
    #[arg(long = "schema-version")]
    schema_version: bool,
}

/// Default verb: parse each input to a structural JSON document, one per line.
#[derive(Args)]
struct ParseArgs {
    /// Input files; `-` reads stdin. With no path given, reads stdin.
    files: Vec<String>,
    /// 2-space indent; single input only (NDJSON needs one line per doc).
    #[arg(long)]
    pretty: bool,
    /// Surface a region label in `regions[]` (repeatable).
    #[arg(long = "region")]
    regions: Vec<String>,
}

#[derive(Subcommand)]
enum Commands {
    /// Freeze gate: byte-exact tiling + inline grammar. Summary → stderr,
    /// nothing on stdout, exit 4 if any input fails the gate.
    #[command(after_help = CHECK_AFTER_HELP, after_long_help = CHECK_AFTER_HELP)]
    Check(CheckArgs),
    /// Type-coverage report over the parsed model → stdout.
    #[command(after_help = STATS_AFTER_HELP, after_long_help = STATS_AFTER_HELP)]
    Stats(StatsArgs),
}

#[derive(Args)]
struct CheckArgs {
    /// Input files; `-` reads stdin. With no path given, reads stdin.
    files: Vec<String>,
    /// Register a region label so the opt-in region-slice check runs (repeatable).
    #[arg(long = "region")]
    regions: Vec<String>,
}

#[derive(Args)]
struct StatsArgs {
    /// Input files; `-` reads stdin. With no path given, reads stdin.
    files: Vec<String>,
    /// Surface a region label in `regions[]` (repeatable).
    #[arg(long = "region")]
    regions: Vec<String>,
}

const TOP_AFTER_HELP: &str = "\
Output:
  stdout carries the NDJSON structural model — one JSON document per input line.
  Spans are byte offsets into the ORIGINAL input; consumers slice their own
  source bytes off those offsets. mdstruct never restringifies content.

Exit codes:
  0 ok · 1 io · 2 usage · 3 non-UTF8 · 4 check-failed

Run `mdstruct --help` for the full contract, worked examples, and per-verb help.";

const TOP_AFTER_LONG_HELP: &str = "\
Verbs:
  mdstruct [FILES]...        parse → NDJSON on stdout (default verb)
  mdstruct check [FILES]...  freeze gate → summary on stderr, exit 4 on failure
  mdstruct stats [FILES]...  type-coverage report → stdout
  mdstruct --schema-version  print the schema contract version and exit

Output:
  stdout carries the NDJSON structural model: one JSON document per line, one
  line per input. Every span is a pair of byte offsets into the ORIGINAL input;
  a consumer reconstructs any slice by indexing its OWN original bytes with those
  offsets. mdstruct never restringifies the source — the emitted model is a pure
  byte-exact index over content it read verbatim. Diagnostics and summaries go to
  stderr, so stdout stays machine-clean for a downstream `jq` or reader.

Exit codes:
  0  ok
  1  io error (unreadable file or stdin failure)
  2  usage misuse (e.g. --pretty with more than one input)
  3  input is not valid UTF-8
  4  check failed (the freeze gate rejected at least one input)
  Across multiple files the process exits with the max code observed.

Examples:
  mdstruct note.md | jq '.headings'          structural model piped to jq
  mdstruct --pretty note.md                  human-readable single-doc JSON
  echo '# hi' | mdstruct -                   parse stdin ('-' or no path)
  mdstruct check ~/vault/**/*.md             freeze-gate a corpus (exit 4 on fail)
  mdstruct stats note.md                     type-coverage table on stdout
  mdstruct check --region interact note.md   gate incl. the 'interact' region slice
  mdstruct --schema-version                  print the schema contract version";

const CHECK_AFTER_HELP: &str = "\
Contract:
  Runs the byte-exact total-tiling + inline-grammar freeze gate over each input.
  Writes a `N/N files passed` summary and any failure detail to stderr, emits
  NOTHING on stdout, and exits 4 if any input fails the gate (0 if all pass).

Exit codes:
  0 ok · 1 io · 2 usage · 3 non-UTF8 · 4 check-failed

Examples:
  mdstruct check note.md                     gate a single file
  mdstruct check ~/vault/**/*.md             gate a corpus
  mdstruct check --region interact note.md   also verify the 'interact' region slice";

const STATS_AFTER_HELP: &str = "\
Contract:
  Parses each input and prints a type-coverage report (node/heading types, then
  inline types, with counts) to stdout. The table IS the output.

Exit codes:
  0 ok · 1 io · 2 usage · 3 non-UTF8

Examples:
  mdstruct stats note.md                     coverage table on stdout
  mdstruct stats note.md 2>/dev/null         table survives — it is on stdout";

fn read_stdin() -> io::Result<Vec<u8>> {
    let mut buf = Vec::new();
    io::stdin().read_to_end(&mut buf)?;
    Ok(buf)
}

/// An empty input list means "read stdin" (`-`).
fn resolve(files: &[String]) -> Vec<String> {
    if files.is_empty() {
        vec!["-".to_string()]
    } else {
        files.to_vec()
    }
}

/// Read one input by path (`-` = stdin). Returns (display-path, bytes) or the
/// exit code to accumulate on failure (1 = io).
fn read_input(f: &str) -> Result<(String, Vec<u8>), u8> {
    if f == "-" {
        match read_stdin() {
            Ok(b) => Ok(("-".to_string(), b)),
            Err(e) => {
                eprintln!("mdstruct: stdin: {e}");
                Err(1)
            }
        }
    } else {
        match std::fs::read(f) {
            Ok(b) => Ok((f.to_string(), b)),
            Err(e) => {
                eprintln!("mdstruct: {f}: {e}");
                Err(1)
            }
        }
    }
}

fn main() -> ExitCode {
    let cli = Cli::parse();

    if cli.schema_version {
        println!("{SCHEMA_VERSION}");
        return ExitCode::SUCCESS;
    }

    let exit = match cli.command {
        Some(Commands::Check(args)) => run_check(&args),
        Some(Commands::Stats(args)) => run_stats(&args),
        None => run_parse(&cli.parse),
    };
    ExitCode::from(exit)
}

fn run_parse(args: &ParseArgs) -> u8 {
    let files = resolve(&args.files);
    if args.pretty && files.len() != 1 {
        eprintln!("mdstruct: --pretty is legal only with a single input");
        return 2;
    }

    let opts = Options {
        wikilinks: true,
        regions: args.regions.clone(),
    };
    let mut exit: u8 = 0;
    let stdout = io::stdout();
    let mut out = stdout.lock();

    for f in &files {
        let (path, bytes) = match read_input(f) {
            Ok(v) => v,
            Err(code) => {
                exit = exit.max(code);
                continue;
            }
        };
        let doc = match parse_bytes(&path, &bytes, &opts) {
            Ok(d) => d,
            Err(_) => {
                eprintln!("mdstruct: {path}: input is not valid UTF-8");
                exit = exit.max(3);
                continue;
            }
        };
        let res = if args.pretty {
            serde_json::to_writer_pretty(&mut out, &doc)
        } else {
            serde_json::to_writer(&mut out, &doc)
        };
        if res.is_ok() {
            let _ = out.write_all(b"\n");
        }
    }
    exit
}

fn run_check(args: &CheckArgs) -> u8 {
    let files = resolve(&args.files);
    let opts = Options {
        wikilinks: true,
        regions: args.regions.clone(),
    };
    let mut exit: u8 = 0;
    let mut files_ok = 0usize;
    let mut files_checked = 0usize;

    for f in &files {
        let (path, bytes) = match read_input(f) {
            Ok(v) => v,
            Err(code) => {
                exit = exit.max(code);
                continue;
            }
        };
        let doc = match parse_bytes(&path, &bytes, &opts) {
            Ok(d) => d,
            Err(_) => {
                eprintln!("mdstruct: {path}: input is not valid UTF-8");
                exit = exit.max(3);
                continue;
            }
        };
        // Safe: parse_bytes already validated UTF-8.
        let source = std::str::from_utf8(&bytes).unwrap();

        files_checked += 1;
        if let Err(e) = verify_spans(&doc, source) {
            eprintln!("mdstruct: {path}: CHECK FAILED: {e}");
            exit = exit.max(4);
            continue;
        }
        files_ok += 1;
    }

    eprintln!("mdstruct check: {files_ok}/{files_checked} files passed the freeze gate");
    exit
}

fn run_stats(args: &StatsArgs) -> u8 {
    let files = resolve(&args.files);
    let opts = Options {
        wikilinks: true,
        regions: args.regions.clone(),
    };
    let mut exit: u8 = 0;
    let mut node_counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut inline_counts: BTreeMap<String, usize> = BTreeMap::new();

    for f in &files {
        let (path, bytes) = match read_input(f) {
            Ok(v) => v,
            Err(code) => {
                exit = exit.max(code);
                continue;
            }
        };
        let doc = match parse_bytes(&path, &bytes, &opts) {
            Ok(d) => d,
            Err(_) => {
                eprintln!("mdstruct: {path}: input is not valid UTF-8");
                exit = exit.max(3);
                continue;
            }
        };
        count_nodes(&doc.nodes, &mut node_counts);
        for h in &doc.headings {
            count_heading(h, &mut node_counts);
        }
        for i in &doc.inlines {
            *inline_counts.entry(i.kind().to_string()).or_default() += 1;
        }
    }

    let stdout = io::stdout();
    let mut out = stdout.lock();
    let _ = writeln!(out, "=== node/heading types ===");
    for (k, v) in &node_counts {
        let _ = writeln!(out, "{k:22} {v}");
    }
    let _ = writeln!(out, "=== inline types ===");
    for (k, v) in &inline_counts {
        let _ = writeln!(out, "{k:22} {v}");
    }
    exit
}

fn count_nodes(nodes: &[mdstruct::Node], counts: &mut BTreeMap<String, usize>) {
    for n in nodes {
        *counts.entry(n.kind().to_string()).or_default() += 1;
        count_nodes(n.children(), counts);
    }
}

fn count_heading(h: &mdstruct::Heading, counts: &mut BTreeMap<String, usize>) {
    *counts.entry(format!("heading{}", h.level)).or_default() += 1;
    for c in &h.children {
        count_heading(c, counts);
    }
}
