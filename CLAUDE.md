# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

nix-darwin flake managing macOS system configuration (aarch64-darwin). Combines nix-darwin, home-manager, and nix-homebrew. Multi-host support via `mkDarwinConfig` in flake.nix.

## Apply Changes

```bash
./rebuild.sh
```

This runs `darwin-rebuild switch --flake ~/nix`, installs Claude plugins, global npm packages, and collects garbage. For a quick test without the extras: `sudo darwin-rebuild switch --flake ~/nix`.

## Format Nix Files

```bash
alejandra .
```

The flake declares `alejandra` as the formatter.

## Structure

- `flake.nix` — system packages (Nix), homebrew brews/casks, macOS defaults, dock layout
- `home/default.nix` — home-manager entry: user packages, program toggles, symlinks for Claude/Ghostty/micro configs
- `home/*.nix` — individual modules: zsh, tmux, git, starship, yazi
- `home/ghostty-config`, `home/micro-settings.json` — app configs symlinked to `~/.config/`
- `home/claude/` — Claude Code config (settings.json, CLAUDE.md, skills/, hooks/) symlinked to `~/.claude/`
- `rebuild.sh` — full rebuild + plugin install + garbage collection

## Key Pattern: Out-of-Store Symlinks

Config files in `home/claude/` and `home/ghostty-config` are symlinked via `mkOutOfStoreSymlink`, not copied into the Nix store. This means edits to these files take effect immediately without rebuilding.

## Adding Packages

- **Nix packages**: `environment.systemPackages` in flake.nix (system-level) or `home.packages` in home/default.nix (user-level)
- **Homebrew brews**: `homebrew.brews` in flake.nix
- **Homebrew casks**: `homebrew.casks` in flake.nix

Homebrew `onActivation.cleanup = "zap"` removes anything not declared. If you add a cask or brew, it must go in flake.nix or it gets wiped on rebuild.
