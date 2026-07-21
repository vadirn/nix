//! `mdread` CLI — fold a Markdown file to its heading tree, or unfold one
//! addressed section.

use std::io::Read as _;
use std::path::PathBuf;

use anyhow::Result;
use clap::Parser;

use mdread::{HeadingRule, TextJson};

#[derive(Parser)]
#[command(
    name = "mdread",
    version,
    about = "Structured Markdown reader: folded heading tree, or one unfolded section",
    long_about = "Print a Markdown file with its structure folded to one line per section \
(with line and estimated-token counts), then unfold just the part you want by address.\n\n\
An address is a dotted-numeric path into the heading tree (`2.1.3`), a heading slug \
(`installation`), `0`/`text` for the pre-heading lede, or `fm`/`frontmatter` for the \
frontmatter block (`fm.<key>` for one field)."
)]
struct Cli {
    /// Path to the Markdown file ("-" reads stdin)
    file: PathBuf,
    /// Address: numeric (2.1), heading slug, 0/text, or fm[.key] for frontmatter
    address: Option<String>,
    /// Max levels to expand under the addressed node
    #[arg(long)]
    depth: Option<usize>,
    /// Expand everything, ignoring threshold and depth
    #[arg(long)]
    full: bool,
    /// Inline cutoff in estimated tokens
    #[arg(long)]
    threshold: Option<usize>,
    /// Output format: text (default) or json
    #[arg(long, default_value = "text")]
    format: TextJson,
    /// Count only column-1, non-setext ATX headings (the stricter vault rule);
    /// the default follows CommonMark, which allows 0-3 spaces of indent
    #[arg(long)]
    strict_headings: bool,
}

fn main() {
    let cli = Cli::parse();
    if let Err(e) = run(&cli) {
        eprintln!("{}", e);
        std::process::exit(1);
    }
}

fn run(cli: &Cli) -> Result<()> {
    let rule = if cli.strict_headings {
        HeadingRule::StrictColumn1
    } else {
        HeadingRule::CommonMark
    };

    if cli.file.as_os_str() == "-" {
        let mut content = String::new();
        std::io::stdin().read_to_string(&mut content)?;
        return mdread::run_content(
            "-",
            &content,
            cli.address.as_deref(),
            cli.depth,
            cli.full,
            cli.threshold,
            cli.format,
            rule,
        );
    }

    mdread::run(
        &cli.file,
        cli.address.as_deref(),
        cli.depth,
        cli.full,
        cli.threshold,
        cli.format,
        rule,
    )
}
