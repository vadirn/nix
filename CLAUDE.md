# nix

Personal macOS system config: a Nix flake managing two Macs, the Claude Code global configuration, and two Rust crates (`mdstruct`, `vault-query`) for an Obsidian vault.

**Read `README.md` first.** It maps the top-level directories — `home/` (home-manager modules + Claude config under `home/claude/`), `hosts/`, `mdstruct/` (shared markdown-parsing core), `vault-query/` (vault query CLI) — and what each holds.

## Building

- `cargo` isn't reliably on PATH — a bare non-login shell can miss it, though the absolute path `/etc/profiles/per-user/vadim/bin/cargo` and an interactive login shell both resolve it. Build the Rust crates through Nix instead: `nix build .#mdstruct` and `nix build .#vault-query` (both run the crate tests as part of the build). `vault-query` links `mdstruct` as a path dependency, so changing `mdstruct` can require rebuilding both.
- `./rebuild.sh` runs `darwin-rebuild switch` and deploys everything: the system, Claude agent symlinks, and npm globals. Deployed binaries live at `/run/current-system/sw/bin/`.
