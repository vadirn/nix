# Dev toolchain for vault-query. `nix-shell` evaluates this in place (no flake
# source copy); <nixpkgs> resolves through the system registry pin to the same
# nixpkgs the flake builds the package with, so dev and deploy compilers match.
{pkgs ? import <nixpkgs> {}}:
pkgs.mkShell {
  packages = with pkgs; [cargo rustc clippy];
}
