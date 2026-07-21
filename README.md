```text
   *    .    *      _       .    *
              .    (_)   *
  .      _ __  ___  __         .
   *    | '_ \| \ \/ /    *
        | | | | |>  <       .
   .    |_| |_|_/_/\_\  *
         aarch64-darwin
```

Personal macOS system config. Three areas: a Nix flake that declaratively manages two Macs, a full Claude Code global configuration, and Rust tooling for an Obsidian vault — a shared markdown-parsing core (`mdstruct`), a general markdown reader (`mdread`), and a query CLI (`vault-query`) built on both.

## Machines

`vdrn-studio` and `vdrn-mbp`. Both aarch64-darwin, both managed by the same `flake.nix` on the `nixos-25.11` branch.

## Nix / home-manager

`flake.nix` is the entry point. `home/` holds all home-manager modules: packages, dotfiles, zsh, git (SSH signing, global hooks), tmux, starship, yazi, Ghostty, lazygit, micro, and delta with a Catppuccin Mocha theme.

`rebuild.sh` is the single command that runs `darwin-rebuild switch`, installs Zed/browser plugins, syncs agent symlinks, and installs npm globals.

## Claude Code configuration

`home/claude/` contains `settings.json` with sandbox permissions and environment variables. `home/claude/hooks/` has PreToolUse safety hooks: dangerous command blocking, sensitive file guards, `/commit` and `/pr` nonce enforcement, firecrawl routing, and sound notifications.

`agents/AGENTS.md` is the shared reasoning and communication ruleset (dialectical method, formal logic, prose style). `agents/skills/` holds ~30 skills (`commit`, `pr`, `vault`, `firecrawl-*`, `debate`, `probe`, `work`, `tdd`, `writing-*`, `design`, etc.). `agents/agents/` holds subagent definitions. `agents/scripts/sync-agents.sh` re-creates agent symlinks without a full rebuild.

## Rust workspace

The three crates form one cargo workspace rooted at `Cargo.toml`, chained by path dependency: `vault-query → mdread → mdstruct`. One lockfile, one `target/`, one `cargo test --workspace`, and — because a single lockfile vendors a single dependency set — one `cargoHash` in `flake.nix`, shared by all three `buildRustPackage` derivations and recomputed once when a dependency changes. Dependencies used by more than one member are declared in `[workspace.dependencies]` and inherited with `.workspace = true`, so two members cannot drift onto different versions of the same crate. `shell.nix` at the root provides the dev toolchain (`nix-shell`, then `cargo test --workspace`).

Each package still builds on its own — `nix build .#mdread` selects its member with `buildAndTestSubdir`, and cargo finds the root manifest above it.

## mdstruct

A Rust crate in `mdstruct/`. The shared comrak-backed markdown structural-parsing core: it locates structure (headings, fenced code, tables, blockquotes, lists, links, wikilinks, comment-delimited regions, frontmatter) and emits half-open byte spans, never restringifying — consumers slice their own original bytes, so byte-exact write-back is preserved. Exposed both as an in-process library and as a thin JSON CLI (`mdstruct FILES...` → NDJSON, with `check` and `stats` subcommands). Built as a Nix package (`nix build .#mdstruct`) and installed system-wide; `vault-query` links it as a path dependency and the distill skill shells the CLI.

## mdread

A Rust crate in `mdread/`, and the general-purpose consumer of `mdstruct`: read any markdown file without loading all of it. `mdread FILE` folds the file to one line per section with line and estimated-token counts; `mdread FILE <address>` unfolds just the part you want. An address is dotted-numeric (`2.1.3`), a heading slug (`installation`), `0`/`text` for the pre-heading lede, `fm`/`fm.<path>` for the frontmatter block or one value in it (`fm.reference[0].target` navigates the parsed YAML), or `links` for the outgoing links. Two dialect flags cover the places a defensible reading differs: `--strict-headings` rejects the 0–3-space indent CommonMark allows, and `--wikilinks-only` counts `[[wikilinks]]` but not URLs. Built as a Nix package and installed system-wide.

## vault-query

A Rust crate in `vault-query/`. Full-text search via tantivy. Commands cover the full vault surface: `search`, `backlinks`, `tags`, `projects`, `tracks`, `log`, `lint`, `context`, `resolve`, and more. Markdown structure (headings, links, wikilinks, frontmatter) comes from the shared `mdstruct` core. `vault-query read` is a thin wrapper over `mdread` that adds the two vault concerns the general reader must not carry: it resolves an entry name fragment to a path, and it reads in the vault dialect (strict headings, wikilink-only counts). It also subsumes the retired `properties` and `links` commands — `read FILE fm[.path]` for frontmatter, `read FILE links` for outgoing links. Built as a Nix package and installed system-wide.
