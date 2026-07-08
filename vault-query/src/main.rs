use anyhow::Result;
use clap::{Parser, Subcommand};
use std::path::PathBuf;

mod base;
mod commands;
mod config;
mod epistemic;
mod frontmatter;
mod index;
mod mdfacet;
mod output;
mod section;
mod slug;
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

/// Resolve config but tolerate its absence: `Ok(None)` when no vault config is
/// present, `Err` only when a present config fails to read or parse. Used by the
/// `read` arm so a bare `read FILE` works outside a vault while a *broken* config
/// still surfaces as an error instead of being silently treated as absent.
fn resolve_config_optional(cli: &Cli) -> Result<Option<config::ResolvedConfig>> {
    let home = dirs_home()?;
    let cwd = std::env::current_dir()?;
    config::resolve_optional(
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

/// Run the parsed command and return its process exit code. The single
/// `process::exit` lives in `main`; every command path here propagates errors
/// with `?` and yields a code, so error and non-zero branches stay testable and
/// Drop-based cleanup runs before the process tears down.
fn dispatch(cli: &Cli) -> Result<i32> {
    // Commands whose config resolution differs (or that need no config) stay
    // explicit; everything else shares the one `resolve_config(cli)?` below.
    match &cli.command {
        Commands::Properties { file, path, format } => {
            return commands::properties::run(file, path.as_deref(), *format);
        }
        Commands::Links { file } => {
            commands::links::run(file)?;
            return Ok(0);
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
            // bare `read FILE` still works outside a vault. A present-but-broken
            // config surfaces as an error rather than silently degrading.
            let vault_root = resolve_config_optional(cli)?.map(|c| c.vault_root);
            commands::read::run(
                file,
                vault_root.as_deref(),
                address.as_deref(),
                *depth,
                *full,
                *threshold,
                *format,
            )?;
            return Ok(0);
        }
        _ => {}
    }

    // All remaining commands share identical vault-config resolution.
    let cfg = resolve_config(cli)?;
    let code = match &cli.command {
        Commands::Query {
            base_path,
            view,
            format,
        } => {
            commands::query::run(base_path, view, &cfg, *format)?;
            0
        }
        Commands::Tags { sort } => {
            commands::tags::run(&cfg, sort)?;
            0
        }
        Commands::Backlinks { file, no_superseded } => {
            commands::backlinks::run(file, &cfg, *no_superseded)?;
            0
        }
        Commands::Lint { format, rule } => commands::lint::run(&cfg, *format, rule)?,
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
            commands::search::run(query, &cfg, *context, path.as_deref(), *regex, *limit, *format, types, *no_superseded)?;
            0
        }
        Commands::Resolve { slug } => commands::resolve::run(slug, &cfg)?,
        Commands::List { folder, fields, no_superseded } => {
            commands::list::run(&cfg, folder, fields, *no_superseded)?;
            0
        }
        Commands::Files {
            folder,
            count,
            tag,
        } => {
            commands::files::run(&cfg, folder.as_deref(), *count, tag.as_deref())?;
            0
        }
        Commands::Config => {
            commands::config_cmd::run(&cfg)?;
            0
        }
        Commands::Context => {
            commands::context::run(&cfg)?;
            0
        }
        Commands::Tracks { view, format } => {
            commands::tracks::run(&cfg, view, *format)?;
            0
        }
        Commands::TracksInit => {
            commands::tracks::init(&cfg)?;
            0
        }
        Commands::Get { fragment, no_superseded } => {
            commands::get::run(fragment, &cfg, *no_superseded)?
        }
        Commands::Cards => {
            commands::list::run_by_type(&cfg, "card", &["reference".to_string()], false)?;
            0
        }
        Commands::Notes => {
            commands::list::run_by_type(&cfg, "note", &[], false)?;
            0
        }
        Commands::Experiments => {
            commands::list::run_by_type(&cfg, "experiment", &[], false)?;
            0
        }
        Commands::Projects { view } => {
            commands::projects::run(&cfg, view)?;
            0
        }
        Commands::Log { date } => {
            commands::log::run(&cfg, date.as_deref())?;
            0
        }
        Commands::Xp { year } => {
            commands::xp::run(&cfg, *year)?;
            0
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
        } => commands::consult_cmd::run(
            task,
            &cfg,
            types,
            *ambient,
            *format,
            *threshold,
            *no_log,
            log_path.as_deref(),
            *include_superseded,
        )?,
        // Handled by the early-return match above.
        Commands::Properties { .. } | Commands::Links { .. } | Commands::Read { .. } => {
            unreachable!("config-free commands are dispatched before config resolution")
        }
    };
    Ok(code)
}

fn main() {
    let cli = Cli::parse();
    let code = match dispatch(&cli) {
        Ok(code) => code,
        Err(e) => {
            // Match anyhow's default Termination output (full cause chain via Debug).
            eprintln!("Error: {e:?}");
            1
        }
    };
    std::process::exit(code);
}
