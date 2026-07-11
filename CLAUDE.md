# nix

Personal macOS system config: a Nix flake managing two Macs, the Claude Code global configuration, and two Rust crates (`mdstruct`, `vault-query`) for an Obsidian vault.

**Read `README.md` first.** It maps the top-level directories — `home/` (home-manager modules + Claude config under `home/claude/`), `hosts/`, `mdstruct/` (shared markdown-parsing core), `vault-query/` (vault query CLI) — and what each holds.

## Building

- `cargo` is not on PATH. Build the Rust crates through Nix: `nix build .#mdstruct` and `nix build .#vault-query` (both run the crate tests as part of the build). `vault-query` links `mdstruct` as a path dependency, so changing `mdstruct` can require rebuilding both.
- `./rebuild.sh` runs `darwin-rebuild switch` and deploys everything: the system, Claude agent symlinks, and npm globals. Deployed binaries live at `/run/current-system/sw/bin/`.
