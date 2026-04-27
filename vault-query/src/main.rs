use anyhow::Result;
use clap::{Parser, Subcommand};
use std::path::PathBuf;

mod base;
mod commands;
mod config;
mod frontmatter;
mod output;
mod vault;
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
    /// Show frontmatter properties of a file
    Properties {
        /// Path to the .md file
        file: PathBuf,
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
    },
    /// Find orphan files (no incoming links)
    Orphans,
    /// Find unresolved wikilinks
    Unresolved,
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
    /// Query project checkpoints
    Checkpoints {
        /// View name (All, Incomplete, Done, Stats)
        #[arg(long, default_value = "All")]
        view: String,
        /// Output format
        #[arg(long, default_value = "table")]
        format: output::Format,
    },
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
    /// Find and read a note/card/reference/checkpoint by name
    Get {
        /// Name fragment to resolve
        fragment: String,
    },
    /// List all cards with metadata
    Cards,
    /// List all notes with metadata
    Notes,
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
}

fn resolve_vault_root(cli: &Cli) -> Result<PathBuf> {
    if let Some(ref vr) = cli.vault_root {
        return Ok(vr.clone());
    }
    Ok(resolve_config(cli)?.vault_root)
}

fn resolve_config(cli: &Cli) -> Result<config::ResolvedConfig> {
    let home = dirs_home()?;
    let cwd = std::env::current_dir()?;
    config::resolve(
        &cwd,
        &home,
        cli.project.as_deref(),
        cli.vault_root.as_deref(),
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
            let vault_root = resolve_vault_root(&cli)?;
            commands::query::run(base_path, view, &vault_root, *format)
        }
        Commands::Properties { file, format } => commands::properties::run(file, *format),
        Commands::Tags { sort } => {
            let vault_root = resolve_vault_root(&cli)?;
            commands::tags::run(&vault_root, sort)
        }
        Commands::Links { file } => commands::links::run(file),
        Commands::Backlinks { file } => {
            let vault_root = resolve_vault_root(&cli)?;
            commands::backlinks::run(file, &vault_root)
        }
        Commands::Orphans => {
            let vault_root = resolve_vault_root(&cli)?;
            commands::orphans::run(&vault_root)
        }
        Commands::Unresolved => {
            let vault_root = resolve_vault_root(&cli)?;
            commands::unresolved::run(&vault_root)
        }
        Commands::Search {
            query,
            context,
            path,
            regex,
            limit,
        } => {
            let vault_root = resolve_vault_root(&cli)?;
            commands::search::run(query, &vault_root, *context, path.as_deref(), *regex, *limit)
        }
        Commands::Resolve { slug } => {
            let vault_root = resolve_vault_root(&cli)?;
            let found = commands::resolve::run(slug, &vault_root)?;
            if !found {
                std::process::exit(1);
            }
            Ok(())
        }
        Commands::List { folder, fields } => {
            let vault_root = resolve_vault_root(&cli)?;
            commands::list::run(&vault_root, folder, fields)
        }
        Commands::Files {
            folder,
            count,
            tag,
        } => {
            let vault_root = resolve_vault_root(&cli)?;
            commands::files::run(&vault_root, folder.as_deref(), *count, tag.as_deref())
        }
        Commands::Config => {
            let cfg = resolve_config(&cli)?;
            commands::config_cmd::run(&cfg)
        }
        Commands::Context => {
            let cfg = resolve_config(&cli)?;
            commands::context::run(&cfg)
        }
        Commands::Checkpoints { view, format } => {
            let cfg = resolve_config(&cli)?;
            commands::checkpoints::run(&cfg, view, *format)
        }
        Commands::Tracks { view, format } => {
            let cfg = resolve_config(&cli)?;
            commands::tracks::run(&cfg, view, *format)
        }
        Commands::TracksInit => {
            let cfg = resolve_config(&cli)?;
            commands::tracks::init(&cfg)
        }
        Commands::Get { fragment } => {
            let vault_root = resolve_vault_root(&cli)?;
            commands::get::run(fragment, &vault_root)
        }
        Commands::Cards => {
            let vault_root = resolve_vault_root(&cli)?;
            commands::list::run(&vault_root, "20 cards", &["reference".to_string()])
        }
        Commands::Notes => {
            let vault_root = resolve_vault_root(&cli)?;
            commands::list::run(&vault_root, "30 notes", &[])
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
    }
}
