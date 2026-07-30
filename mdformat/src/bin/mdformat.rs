//! Thin CLI over the `mdformat` crate. One verb so far:
//!   fixpoint   parse each input under mdstruct's shared comrak config and
//!              write it back out (stub: identity — the printer is next).

use std::io::{self, Read, Write};
use std::process::ExitCode;

use clap::{Args, Parser, Subcommand};

/// Comrak's parser plus mdstruct's shared parse configuration; the printer
/// itself is the next step.
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
    /// Reformat each input to its byte-exact fixpoint. STUB: today this is
    /// the identity transform (parse, then echo the input unchanged); the
    /// printer that actually reformats lands in a follow-up step.
    Fixpoint(FixpointArgs),
}

#[derive(Args)]
struct FixpointArgs {
    /// Input files; `-` reads stdin. With no path given, reads stdin.
    files: Vec<String>,
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
        let source = match std::str::from_utf8(&bytes) {
            Ok(s) => s,
            Err(_) => {
                eprintln!("mdformat: {path}: input is not valid UTF-8");
                exit = exit.max(3);
                continue;
            }
        };
        let formatted = mdformat::fixpoint_stub(source, &opts);
        let _ = out.write_all(formatted.as_bytes());
    }
    exit
}
