use anyhow::Result;
use clap::{Parser, Subcommand};
use std::path::PathBuf;

mod base;
mod commands;
mod frontmatter;
mod output;
mod vault;
mod wikilink;

#[derive(Parser)]
#[command(name = "vault-query", about = "Query Obsidian vault data")]
struct Cli {
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
        /// Vault root directory
        #[arg(long)]
        vault_root: PathBuf,
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
        /// Vault root directory
        #[arg(long)]
        vault_root: PathBuf,
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
        /// Vault root directory
        #[arg(long)]
        vault_root: PathBuf,
    },
    /// Find orphan files (no incoming links)
    Orphans {
        /// Vault root directory
        #[arg(long)]
        vault_root: PathBuf,
    },
    /// Find unresolved wikilinks
    Unresolved {
        /// Vault root directory
        #[arg(long)]
        vault_root: PathBuf,
    },
    /// Full-text search
    Search {
        /// Search query (regex)
        query: String,
        /// Vault root directory
        #[arg(long)]
        vault_root: PathBuf,
        /// Context lines around matches
        #[arg(long, default_value = "2")]
        context: usize,
        /// Limit search to a subfolder
        #[arg(long)]
        path: Option<PathBuf>,
    },
    /// List files in the vault
    Files {
        /// Vault root directory
        #[arg(long)]
        vault_root: PathBuf,
        /// Limit to a subfolder
        #[arg(long)]
        folder: Option<PathBuf>,
        /// Only show count
        #[arg(long)]
        count: bool,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Commands::Query {
            base_path,
            view,
            vault_root,
            format,
        } => commands::query::run(&base_path, &view, &vault_root, format),
        Commands::Properties { file, format } => commands::properties::run(&file, format),
        Commands::Tags {
            vault_root,
            sort,
        } => commands::tags::run(&vault_root, &sort),
        Commands::Links { file } => commands::links::run(&file),
        Commands::Backlinks {
            file,
            vault_root,
        } => commands::backlinks::run(&file, &vault_root),
        Commands::Orphans { vault_root } => commands::orphans::run(&vault_root),
        Commands::Unresolved { vault_root } => commands::unresolved::run(&vault_root),
        Commands::Search {
            query,
            vault_root,
            context,
            path,
        } => commands::search::run(&query, &vault_root, context, path.as_deref()),
        Commands::Files {
            vault_root,
            folder,
            count,
        } => commands::files::run(&vault_root, folder.as_deref(), count),
    }
}
