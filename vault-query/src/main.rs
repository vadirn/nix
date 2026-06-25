use anyhow::Result;
use clap::{Parser, Subcommand};
use std::path::PathBuf;

mod base;
mod commands;
mod config;
mod frontmatter;
mod output;
mod tokens;
mod vault;
mod vault_ignore;
mod wikilink;

#[derive(Parser)]
#[command(name = "vault-query", about = "Query Obsidian vault data")]
struct Cli {
    /// Vault root directory (resolved from config if omitted)
    #[arg(long, global = true)]
    vault_root: Option<PathBuf>,
    /// Project name (resolves to vault_root/projects_path/name)
    #[arg(long, global = true)]
    project: Option<String>,
    /// Disable .vaultignore filtering
    #[arg(long, global = true)]
    no_ignore: bool,
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Query a .base file with optional view
    Query {
        /// Path to the .base file
        base_path: PathBuf,
        /// View name to apply
        #[arg(long, default_value = "All")]
        view: String,
        /// Output format
        #[arg(long, default_value = "table")]
        format: output::Format,
    },
    /// Read a .md file: folded overview, or unfold an addressed section
    Read {
        /// Path to the .md file
        file: PathBuf,
        /// Section address: numeric (e.g. 2.1), heading slug, or 0/text
        address: Option<String>,
        /// Max levels to expand under the addressed node (Step 2)
        #[arg(long)]
        depth: Option<usize>,
        /// Expand everything, ignoring threshold and depth (Step 2)
        #[arg(long)]
        full: bool,
        /// Inline cutoff in estimated tokens (Step 2)
        #[arg(long)]
        threshold: Option<usize>,
        /// Output format: text (default) or json
        #[arg(long, default_value = "text")]
        format: output::TextJson,
    },
    /// Show frontmatter properties of a file, or read one field by path
    Properties {
        /// Path to the .md file
        file: PathBuf,
        /// Optional field path: dotted keys with [i] indices (e.g. references[0].target)
        path: Option<String>,
        /// Output format
        #[arg(long, default_value = "table")]
        format: output::Format,
    },
    /// List tags across the vault
    Tags {
        /// Sort by: name or count
        #[arg(long, default_value = "name")]
        sort: String,
    },
    /// Show outgoing links from a file
    Links {
        /// Path to the .md file
        file: PathBuf,
    },
    /// Show incoming links to a file
    Backlinks {
        /// Path to the .md file
        file: PathBuf,
        /// Exclude superseded entries (superseded: true or type: checkpoint)
        #[arg(long)]
        no_superseded: bool,
    },
    /// Run vault-wide lint rules
    Lint {
        /// Output format
        #[arg(long, default_value = "text")]
        format: commands::lint::format::LintFormat,
        /// Override a rule's severity, e.g. --rule orphan-card=error (repeatable)
        #[arg(long, value_name = "NAME=SEVERITY")]
        rule: Vec<String>,
    },
    /// Full-text search (BM25 ranked by default, regex with --regex)
    Search {
        /// Search query
        query: String,
        /// Context lines around matches (regex mode only)
        #[arg(long, default_value = "2")]
        context: usize,
        /// Limit search to a subfolder
        #[arg(long)]
        path: Option<PathBuf>,
        /// Use regex grep instead of BM25
        #[arg(long)]
        regex: bool,
        /// Max results (BM25 mode only)
        #[arg(short = 'n', long, default_value = "20")]
        limit: usize,
        /// Output format: text (default) or json
        #[arg(long, default_value = "text")]
        format: output::TextJson,
        /// Filter by frontmatter `type:` (comma-separated). Default: all types.
        #[arg(long, value_delimiter = ',')]
        types: Vec<String>,
        /// Exclude superseded entries (superseded: true or type: checkpoint)
        #[arg(long)]
        no_superseded: bool,
    },
    /// Resolve a slug to a vault file path
    Resolve {
        /// Slug to resolve (e.g. "impureim-sandwich")
        slug: String,
    },
    /// List files in a folder with frontmatter metadata
    List {
        /// Folder relative to vault root (e.g. "20 cards")
        folder: String,
        /// Extra frontmatter fields to display (comma-separated)
        #[arg(long, value_delimiter = ',')]
        fields: Vec<String>,
        /// Exclude superseded entries (superseded: true or type: checkpoint)
        #[arg(long)]
        no_superseded: bool,
    },
    /// List files in the vault
    Files {
        /// Limit to a subfolder
        #[arg(long)]
        folder: Option<PathBuf>,
        /// Only show count
        #[arg(long)]
        count: bool,
        /// Filter to files with this tag
        #[arg(long)]
        tag: Option<String>,
    },
    /// Print resolved config as JSON
    Config,
    /// Print project context.md
    Context,
    /// Query project tracks
    Tracks {
        /// View name (Active, Open, Paused, Done, Abandoned, Superseded, All, Stats)
        #[arg(long, default_value = "Active")]
        view: String,
        /// Output format
        #[arg(long, default_value = "table")]
        format: output::Format,
    },
    /// Initialize Tracks.base in the current project
    TracksInit,
    /// Resolve a note/card/reference/checkpoint name to its absolute path (one per line)
    Get {
        /// Name fragment to resolve
        fragment: String,
        /// Exclude superseded entries: exit 1 if the resolved entry is superseded
        #[arg(long)]
        no_superseded: bool,
    },
    /// List all cards with metadata
    Cards,
    /// List all notes with metadata
    Notes,
    /// List all experiments with metadata
    Experiments,
    /// List active projects
    Projects {
        /// View name for base query
        #[arg(long, default_value = "Активные проекты")]
        view: String,
    },
    /// Open or create weekly log
    Log {
        /// Date specifier: empty=current, last/prev, next, N, WN, YYYY-WNN, YYYY-MM-DD
        date: Option<String>,
    },
    /// XP report: calendar, streak, level
    Xp {
        /// Year to report (defaults to current)
        year: Option<i32>,
    },
    /// Retrieve vault context for a task (retrieve → select → emit)
    Consult {
        /// Query string describing the task or topic
        task: String,
        /// Comma-separated frontmatter types to search (overrides config types)
        #[arg(long, value_delimiter = ',')]
        types: Vec<String>,
        /// Stricter abstain gate for ambient/hook invocations (Decision 18)
        #[arg(long)]
        ambient: bool,
        /// Output format: markdown (default) or json
        #[arg(long, default_value = "markdown")]
        format: commands::consult_cmd::ConsultFormat,
        /// Absolute score backstop; overrides config threshold (optional)
        #[arg(long)]
        threshold: Option<f32>,
        /// Suppress JSONL instrumentation for this invocation (overrides --log-path and config log_path)
        #[arg(long)]
        no_log: bool,
        /// Write this invocation's JSONL record to PATH instead of config log_path
        #[arg(long, value_name = "PATH")]
        log_path: Option<String>,
        /// Include superseded entries (superseded: true) and checkpoints in consult scope
        #[arg(long)]
        include_superseded: bool,
    },
}

fn resolve_config(cli: &Cli) -> Result<config::ResolvedConfig> {
    let home = dirs_home()?;
    let cwd = std::env::current_dir()?;
    config::resolve(
        &cwd,
        &home,
        cli.project.as_deref(),
        cli.vault_root.as_deref(),
        !cli.no_ignore,
    )
}

fn dirs_home() -> Result<PathBuf> {
    std::env::var("HOME")
        .map(PathBuf::from)
        .map_err(|_| anyhow::anyhow!("HOME not set"))
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match &cli.command {
        Commands::Query {
            base_path,
            view,
            format,
        } => {
            let cfg = resolve_config(&cli)?;
            commands::query::run(base_path, view, &cfg, *format)
        }
        Commands::Read {
            file,
            address,
            depth,
            full,
            threshold,
            format,
        } => {
            // Resolve config so vault-relative pointer paths work from any cwd;
            // fall back to None (cwd-only) when no vault config is present so a
            // bare `read FILE` still works outside a vault.
            let vault_root = resolve_config(&cli).ok().map(|c| c.vault_root);
            commands::read::run(
                file,
                vault_root.as_deref(),
                address.as_deref(),
                *depth,
                *full,
                *threshold,
                *format,
            )
        }
        Commands::Properties { file, path, format } => {
            commands::properties::run(file, path.as_deref(), *format)
        }
        Commands::Tags { sort } => {
            let cfg = resolve_config(&cli)?;
            commands::tags::run(&cfg, sort)
        }
        Commands::Links { file } => commands::links::run(file),
        Commands::Backlinks { file, no_superseded } => {
            let cfg = resolve_config(&cli)?;
            commands::backlinks::run(file, &cfg, *no_superseded)
        }
        Commands::Lint { format, rule } => {
            let cfg = resolve_config(&cli)?;
            let exit = commands::lint::run(&cfg, *format, rule)?;
            if exit != 0 {
                std::process::exit(exit);
            }
            Ok(())
        }
        Commands::Search {
            query,
            context,
            path,
            regex,
            limit,
            format,
            types,
            no_superseded,
        } => {
            let cfg = resolve_config(&cli)?;
            commands::search::run(query, &cfg, *context, path.as_deref(), *regex, *limit, *format, types, *no_superseded)
        }
        Commands::Resolve { slug } => {
            let cfg = resolve_config(&cli)?;
            let found = commands::resolve::run(slug, &cfg)?;
            if !found {
                std::process::exit(1);
            }
            Ok(())
        }
        Commands::List { folder, fields, no_superseded } => {
            let cfg = resolve_config(&cli)?;
            commands::list::run(&cfg, folder, fields, *no_superseded)
        }
        Commands::Files {
            folder,
            count,
            tag,
        } => {
            let cfg = resolve_config(&cli)?;
            commands::files::run(&cfg, folder.as_deref(), *count, tag.as_deref())
        }
        Commands::Config => {
            let cfg = resolve_config(&cli)?;
            commands::config_cmd::run(&cfg)
        }
        Commands::Context => {
            let cfg = resolve_config(&cli)?;
            commands::context::run(&cfg)
        }
        Commands::Tracks { view, format } => {
            let cfg = resolve_config(&cli)?;
            commands::tracks::run(&cfg, view, *format)
        }
        Commands::TracksInit => {
            let cfg = resolve_config(&cli)?;
            commands::tracks::init(&cfg)
        }
        Commands::Get { fragment, no_superseded } => {
            let cfg = resolve_config(&cli)?;
            commands::get::run(fragment, &cfg, *no_superseded)
        }
        Commands::Cards => {
            let cfg = resolve_config(&cli)?;
            commands::list::run_by_type(&cfg, "card", &["reference".to_string()], false)
        }
        Commands::Notes => {
            let cfg = resolve_config(&cli)?;
            commands::list::run_by_type(&cfg, "note", &[], false)
        }
        Commands::Experiments => {
            let cfg = resolve_config(&cli)?;
            commands::list::run_by_type(&cfg, "experiment", &[], false)
        }
        Commands::Projects { view } => {
            let cfg = resolve_config(&cli)?;
            commands::projects::run(&cfg, view)
        }
        Commands::Log { date } => {
            let cfg = resolve_config(&cli)?;
            commands::log::run(&cfg, date.as_deref())
        }
        Commands::Xp { year } => {
            let cfg = resolve_config(&cli)?;
            commands::xp::run(&cfg, *year)
        }
        Commands::Consult {
            task,
            types,
            ambient,
            format,
            threshold,
            no_log,
            log_path,
            include_superseded,
        } => {
            let cfg = resolve_config(&cli)?;
            let exit_code = commands::consult_cmd::run(
                task,
                &cfg,
                types,
                *ambient,
                *format,
                *threshold,
                *no_log,
                log_path.as_deref(),
                *include_superseded,
            )?;
            if exit_code != 0 {
                std::process::exit(exit_code);
            }
            Ok(())
        }
    }
}
