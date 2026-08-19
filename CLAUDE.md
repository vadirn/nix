# nix

Personal macOS system config: a Nix flake managing two Macs, the Claude Code global configuration, and `vault-query`, a Rust CLI for an Obsidian vault. The markdown crates it builds on (`mdstruct`, `mdread`, `mdformat`, `mdsearch`) live in [md-for-agents](https://github.com/vadirn/md-for-agents) and arrive as a pinned flake input.

**Read `README.md` first.** It maps the top-level directories — `home/` (home-manager modules + Claude config under `home/claude/`), `hosts/`, `vault-query/` (vault query CLI), `scripts/` (the mdformat corpus and dry-run harnesses) — and what each holds.

## Building

- `cargo` isn't reliably on PATH — a bare non-login shell can miss it, though the absolute path `/etc/profiles/per-user/vadim/bin/cargo` and an interactive login shell both resolve it. Build through Nix instead: `nix build .#vault-query` and `nix build .#md-for-agents`, both of which run the crate tests as part of the build.
- `vault-query` links `mdstruct` and `mdread` from md-for-agents, tracking `main`. Pull their changes with `cargo update -p mdstruct -p mdread`, then a fresh `cargoHash` in `flake.nix`. The binaries follow a separate pin: `nix flake update md-for-agents`. `Cargo.lock` and `flake.lock` each record a commit, so a build stays reproducible between bumps.
- `./rebuild.sh` runs `darwin-rebuild switch` and deploys everything: the system, Claude agent symlinks, and npm globals. Deployed binaries live at `/etc/profiles/per-user/vadim/bin/`.
- Verify behaviour newly added to a crate by running `./result/bin/<crate>` after `nix build`, not the binary on `PATH`. The `PATH` binary predates the change, so an absent lint finding is indistinguishable from a clean result. `./rebuild.sh` closes the gap; running it is the user's call.
