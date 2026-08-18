# Dev toolchain for `vault-query`. It sits at the workspace root so `nix-shell`
# works from the repo root and `cargo test --workspace` runs there.
# `nix-shell` evaluates this in place (no flake source copy); <nixpkgs> resolves
# through the system registry pin to the same nixpkgs the flake builds the
# packages with, so dev and deploy compilers match.
{pkgs ? import <nixpkgs> {}}:
pkgs.mkShell {
  packages = with pkgs; [cargo rustc clippy rustfmt];
}
