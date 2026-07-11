```text
   *    .    *      _       .    *
              .    (_)   *
  .      _ __  ___  __         .
   *    | '_ \| \ \/ /    *
        | | | | |>  <       .
   .    |_| |_|_/_/\_\  *
         aarch64-darwin
```

Personal macOS system config. Three areas: a Nix flake that declaratively manages two Macs, a full Claude Code global configuration, and Rust tooling for an Obsidian vault — a shared markdown-parsing core (`mdstruct`) and a query CLI (`vault-query`) built on it.

## Machines

`vdrn-studio` and `vdrn-mbp`. Both aarch64-darwin, both managed by the same `flake.nix` on the `nixos-25.11` branch.

## Nix / home-manager

`flake.nix` is the entry point. `home/` holds all home-manager modules: packages, dotfiles, zsh, git (SSH signing, global hooks), tmux, starship, yazi, Ghostty, lazygit, micro, and delta with a Catppuccin Mocha theme.

`rebuild.sh` is the single command that runs `darwin-rebuild switch`, installs Zed/browser plugins, syncs agent symlinks, and installs npm globals.

## Claude Code configuration

`home/claude/` contains `settings.json` with sandbox permissions and environment variables. `home/claude/hooks/` has PreToolUse safety hooks: dangerous command blocking, sensitive file guards, `/commit` and `/pr` nonce enforcement, firecrawl routing, and sound notifications.

`agents/AGENTS.md` is the shared reasoning and communication ruleset (dialectical method, formal logic, prose style). `agents/skills/` holds ~30 skills (`commit`, `pr`, `vault`, `firecrawl-*`, `debate`, `probe`, `work`, `tdd`, `writing-*`, `design`, etc.). `agents/agents/` holds subagent definitions. `agents/scripts/sync-agents.sh` re-creates agent symlinks without a full rebuild.

## mdstruct

A Rust crate in `mdstruct/`. The shared comrak-backed markdown structural-parsing core: it locates structure (headings, fenced code, tables, blockquotes, lists, links, wikilinks, comment-delimited regions, frontmatter) and emits half-open byte spans, never restringifying — consumers slice their own original bytes, so byte-exact write-back is preserved. Exposed both as an in-process library and as a thin JSON CLI (`mdstruct FILES...` → NDJSON, with `check` and `stats` subcommands). Built as a Nix package (`nix build .#mdstruct`) and installed system-wide; `vault-query` links it as a path dependency and the distill skill shells the CLI.

## vault-query

A Rust crate in `vault-query/`. Full-text search via tantivy. Commands cover the full vault surface: `search`, `backlinks`, `links`, `tags`, `properties`, `projects`, `tracks`, `log`, `lint`, `context`, `resolve`, and more. Markdown structure (headings, links, wikilinks, frontmatter) comes from the shared `mdstruct` core. Built as a Nix package and installed system-wide.
