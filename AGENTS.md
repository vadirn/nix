# nix

Personal macOS system config: a Nix flake managing two Macs, the Claude Code global configuration, and `vault-query`, a Rust CLI for an Obsidian vault. The markdown crates it builds on live in [md-for-agents](https://github.com/vadirn/md-for-agents) and arrive as a pinned flake input.

**Read `README.md` first.** It maps the top-level directories — `home/` (home-manager modules + Claude config under `home/claude/`), `hosts/`, `vault-query/` (vault query CLI), `scripts/` (the mdformat corpus and dry-run harnesses) — and what each holds.

## Building

- `cargo` isn't reliably on PATH — a bare non-login shell can miss it, though the absolute path `/etc/profiles/per-user/vadim/bin/cargo` and an interactive login shell both resolve it. Build through Nix instead: `nix build .#vault-query` and `nix build .#md-for-agents`, both of which run the crate tests as part of the build.
- `vault-query` links `mdstruct` from md-for-agents, tracking `main`. Pull its changes with `cargo update -p mdstruct`, then a fresh `cargoHash` in `flake.nix`. The binaries follow a separate pin: `nix flake update md-for-agents`. `Cargo.lock` and `flake.lock` each record a commit, so a build stays reproducible between bumps.
- Each harness's handler list, `home/<harness>/hooky/hooks.json`, must agree with its settings file, `home/claude/settings.json` or `home/codex/hooks.json`: the settings carry exactly the `hooks` block hooky generates from the list. After changing a handler list or hooky's generator, regenerate with the hooky this tree builds (`nix build .#hooky`) and name both files, since a bare `hooky install` writes through `~/.claude/settings.json`'s link into `~/nix`, not into a worktree: `./result/bin/hooky --harness claude --config home/claude/hooky/hooks.json install --bin "~/.local/bin/hooky" --settings home/claude/settings.json`; for Codex, `--harness codex --config home/codex/hooky/hooks.json` and `--settings home/codex/hooks.json`. `nix flake check` then runs the wiring checks; the `hooky wiring` workflow runs them on the pull request.
- `./rebuild.sh` runs `darwin-rebuild switch` and deploys everything: the system, Claude agent symlinks, and npm globals. Deployed binaries live at `/etc/profiles/per-user/vadim/bin/`.
- Verify behaviour newly added to a crate by running `./result/bin/<crate>` after `nix build`, not the binary on `PATH`. The `PATH` binary predates the change, so an absent lint finding is indistinguishable from a clean result. `./rebuild.sh` closes the gap; running it is the user's call.
