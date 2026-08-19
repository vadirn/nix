```text
   *    .    *      _       .    *
              .    (_)   *
  .      _ __  ___  __         .
   *    | '_ \| \ \/ /    *
        | | | | |>  <       .
   .    |_| |_|_/_/\_\  *
         aarch64-darwin
```

Personal macOS system config. Three areas: a Nix flake that declaratively manages two Macs, a full Claude Code global configuration, and `vault-query`, a query CLI for an Obsidian vault. The markdown core it builds on — `mdstruct`, `mdread`, `mdformat`, `mdsearch` — lives in [md-for-agents](https://github.com/vadirn/md-for-agents) and arrives here as a pinned flake input.

## Machines

`vdrn-studio` and `vdrn-mbp`. Both aarch64-darwin, both managed by the same `flake.nix` on the `nixos-25.11` branch.

## Nix / home-manager

`flake.nix` is the entry point. `home/` holds all home-manager modules: packages, dotfiles, zsh, git (SSH signing, global hooks), tmux, starship, yazi, Ghostty, lazygit, micro, and delta with a Catppuccin Mocha theme.

`rebuild.sh` is the single command that runs `darwin-rebuild switch`, installs Zed/browser plugins, syncs agent symlinks, and installs npm globals.

## Claude Code configuration

`home/claude/` contains `settings.json` with sandbox permissions and environment variables. `home/claude/hooks/` has PreToolUse safety hooks: dangerous command blocking, sensitive file guards, `/commit` and `/pr` nonce enforcement, Firecrawl MCP routing, and sound notifications.

Formatting is agent-driven, not automatic: `home/agents/skills/tools/autoformat/autoformat.ts` (a bun CLI, on PATH as `autoformat`) routes each file to its formatter — the project's `format:file` script, else deno fmt, else mdformat for `.md` and oxfmt for the rest, or ruff, or alejandra, or rustfmt — and `home/claude/hooks/hint-autoformat.sh` names it in the PostToolUse context after every Write and Edit. Nothing rewrites a file behind the agent, so a reflow can never land between two Edits and break the second one.

`agents/AGENTS.md` is the shared reasoning and communication ruleset (dialectical method, formal logic, prose style). `agents/skills/` holds ~30 skills (`commit`, `pr`, `vault`, `debate`, `probe`, `work`, `tdd`, `writing-*`, `design`, etc.); it is also a bun workspace with pinned TypeScript and oxlint, whose `tools/` member holds the `autoformat` CLI. `agents/agents/` holds subagent definitions. `agents/scripts/sync-agents.sh` re-creates agent symlinks without a full rebuild.

## Rust workspace

`vault-query` is the only crate in this repo, a one-member workspace rooted at `Cargo.toml`. It links `mdstruct` and `mdread` as a git dependency on [md-for-agents](https://github.com/vadirn/md-for-agents), pinned by rev in `Cargo.lock`. `shell.nix` provides the dev toolchain (`nix-shell`, then `cargo test --workspace`).

## md-for-agents

The four markdown crates, built from the flake input as one derivation (`nix build .#md-for-agents`) carrying all four binaries — `mdstruct`, `mdread`, `mdformat`, `mdsearch`. One derivation rather than four so comrak compiles once, and one `cargoHash` covers the lot. Bump the pin with `nix flake update md-for-agents`. The libraries `vault-query` links follow a separate pin on the same branch: `cargo update -p mdstruct -p mdread`.

- `mdstruct` — the shared comrak-backed structural-parsing core. It locates structure (headings, fenced code, tables, blockquotes, lists, links, wikilinks, comment-delimited regions, frontmatter) and emits half-open byte spans, never restringifying, so consumers slice their own original bytes and byte-exact write-back is preserved. A library and a thin JSON CLI (`mdstruct FILES...` → NDJSON, with `check` and `stats`).
- `mdread` — read any markdown file without loading all of it. `mdread FILE` folds it to one line per section with line and estimated-token counts; `mdread FILE <address>` unfolds one part. An address is dotted-numeric (`2.1.3`), a heading slug, `0`/`text` for the lede, `fm`/`fm.<path>` for frontmatter, or `links`. The reserved names beat a heading that slugs the same way, and the reader announces the collision rather than resolving it. `--strict-headings` rejects CommonMark's 0–3-space indent; `--wikilinks-only` counts `[[wikilinks]]` but not URLs.
- `mdformat` — comrak's parser plus our own printer, a sibling to `mdstruct` rather than built on it, since `mdstruct`'s flat span index is deliberately not printable. Formats markdown to a configurable style. `scripts/corpus.sh` runs its partition and idempotence checks over the vault; `scripts/dryrun.sh` applies one rule to a throwaway copy and leaves a reviewable diff.
- `mdsearch` — rank a folder's markdown files against a query, best match first. BM25 over three fields: the file name, the frontmatter `description:`, and the prose after that block. Terms are stemmed in English and Russian. The walk obeys `.gitignore`, `.ignore`, and `.mdsearchignore`, and skips dot-files unless `--hidden`. The index is built in RAM for the one run, so an edit needs no reindex.

## vault-query

A Rust crate in `vault-query/`. Full-text search via tantivy. Commands cover the full vault surface: `search`, `backlinks`, `tags`, `projects`, `tracks`, `log`, `lint`, `context`, `resolve`, and more. Markdown structure (headings, links, wikilinks, frontmatter) comes from the shared `mdstruct` core. `vault-query read` is a thin wrapper over `mdread` that adds the two vault concerns the general reader must not carry: it resolves an entry name fragment to a path, and it reads in the vault dialect (strict headings, wikilink-only counts). It also subsumes the retired `properties` and `links` commands — `read FILE fm[.path]` for frontmatter, `read FILE links` for outgoing links. Built as a Nix package and installed system-wide.
