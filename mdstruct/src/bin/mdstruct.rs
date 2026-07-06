//! Thin CLI: read → parse → serialize. Always NDJSON (one object per line);
//! `--pretty` is legal only for a single input. `--check` runs the freeze gate.

use std::collections::BTreeMap;
use std::io::{self, Read, Write};
use std::process::ExitCode;

use clap::Parser;
use mdstruct::{Options, SCHEMA_VERSION, parse_bytes, verify_spans};

#[derive(Parser)]
#[command(name = "mdstruct", version, about = "Markdown structural-parsing core → JSON")]
struct Cli {
    /// Input files; `-` reads stdin.
    files: Vec<String>,
    /// 2-space indent (single input only).
    #[arg(long)]
    pretty: bool,
    /// Register a region label to surface in `regions[]` (repeatable).
    #[arg(long = "region")]
    regions: Vec<String>,
    /// Run the byte-exact total-tiling + inline-grammar freeze gate.
    #[arg(long)]
    check: bool,
    /// Print type-coverage stats to stderr instead of emitting JSON.
    #[arg(long)]
    stats: bool,
    /// Print the schema contract version and exit.
    #[arg(long = "schema-version")]
    schema_version: bool,
}

fn read_stdin() -> io::Result<Vec<u8>> {
    let mut buf = Vec::new();
    io::stdin().read_to_end(&mut buf)?;
    Ok(buf)
}

fn main() -> ExitCode {
    let cli = Cli::parse();

    if cli.schema_version {
        println!("{SCHEMA_VERSION}");
        return ExitCode::SUCCESS;
    }

    if cli.files.is_empty() {
        eprintln!("mdstruct: no input files (use `-` for stdin)");
        return ExitCode::from(2);
    }
    if cli.pretty && cli.files.len() != 1 {
        eprintln!("mdstruct: --pretty is legal only with a single input");
        return ExitCode::from(2);
    }

    let opts = Options {
        wikilinks: true,
        regions: cli.regions.clone(),
    };

    let mut exit: u8 = 0;
    let stdout = io::stdout();
    let mut out = stdout.lock();

    // Coverage accumulators (for --stats).
    let mut node_counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut inline_counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut files_ok = 0usize;
    let mut files_checked = 0usize;

    for f in &cli.files {
        let (path, bytes) = if f == "-" {
            match read_stdin() {
                Ok(b) => ("-".to_string(), b),
                Err(e) => {
                    eprintln!("mdstruct: stdin: {e}");
                    exit = exit.max(1);
                    continue;
                }
            }
        } else {
            match std::fs::read(f) {
                Ok(b) => (f.clone(), b),
                Err(e) => {
                    eprintln!("mdstruct: {f}: {e}");
                    exit = exit.max(1);
                    continue;
                }
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

        if cli.check {
            files_checked += 1;
            if let Err(e) = verify_spans(&doc, source) {
                eprintln!("mdstruct: {path}: CHECK FAILED: {e}");
                exit = exit.max(4);
                continue;
            }
            files_ok += 1;
        }

        if cli.stats {
            count_nodes(&doc.nodes, &mut node_counts);
            for h in &doc.headings {
                count_heading(h, &mut node_counts);
            }
            for i in &doc.inlines {
                *inline_counts.entry(i.kind().to_string()).or_default() += 1;
            }
            continue;
        }

        let res = if cli.pretty {
            serde_json::to_writer_pretty(&mut out, &doc)
        } else {
            serde_json::to_writer(&mut out, &doc)
        };
        if res.is_ok() {
            let _ = out.write_all(b"\n");
        }
    }

    if cli.stats {
        eprintln!("=== node/heading types ===");
        for (k, v) in &node_counts {
            eprintln!("{k:22} {v}");
        }
        eprintln!("=== inline types ===");
        for (k, v) in &inline_counts {
            eprintln!("{k:22} {v}");
        }
    }
    if cli.check {
        eprintln!("mdstruct --check: {files_ok}/{files_checked} files passed the freeze gate");
    }

    ExitCode::from(exit)
}

fn count_nodes(nodes: &[mdstruct::Node], counts: &mut BTreeMap<String, usize>) {
    use mdstruct::Node;
    for n in nodes {
        *counts.entry(n.kind().to_string()).or_default() += 1;
        match n {
            Node::BlockQuote { children, .. }
            | Node::List { children, .. }
            | Node::ListItem { children, .. }
            | Node::Table { children, .. }
            | Node::TableRow { children, .. }
            | Node::FootnoteDefinition { children, .. } => count_nodes(children, counts),
            _ => {}
        }
    }
}

fn count_heading(h: &mdstruct::Heading, counts: &mut BTreeMap<String, usize>) {
    *counts.entry(format!("heading{}", h.level)).or_default() += 1;
    for c in &h.children {
        count_heading(c, counts);
    }
}
