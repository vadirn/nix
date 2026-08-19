{
  description = "Darwin system flake";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
    nix-darwin.url = "github:LnL7/nix-darwin/nix-darwin-25.11";
    nix-darwin.inputs.nixpkgs.follows = "nixpkgs";
    nix-homebrew = {
      url = "github:zhaofengli/nix-homebrew/de7953a0";
      inputs.brew-src.url = "github:Homebrew/brew/6.0.15";
    };

    homebrew-dopplerhq-cli = {
      url = "github:dopplerhq/homebrew-cli";
      flake = false;
    };
    homebrew-arimxyer-tap = {
      url = "github:arimxyer/homebrew-tap";
      flake = false;
    };
    homebrew-oven-sh-bun = {
      url = "github:oven-sh/homebrew-bun";
      flake = false;
    };
    homebrew-anomalyco-tap = {
      url = "github:anomalyco/homebrew-tap";
      flake = false;
    };
    homebrew-basecamp-tap = {
      url = "github:basecamp/homebrew-tap";
      flake = false;
    };

    home-manager.url = "github:nix-community/home-manager/release-25.11";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";

    # The markdown crates, pinned as a plain source tree: the repo carries no
    # flake.nix, and flake.lock holds the rev, so `nix flake update` bumps it.
    md-for-agents = {
      url = "github:vadirn/md-for-agents";
      flake = false;
    };
  };

  outputs = inputs @ {
    self,
    nixpkgs,
    nix-darwin,
    nix-homebrew,
    home-manager,
    ...
  }: let
    system = "aarch64-darwin";
    pkgs = nixpkgs.legacyPackages.${system};
    inherit (pkgs) lib;
    # `vault-query` is the only crate left in this repo. Its build source is the
    # workspace manifest, the single lockfile, and its own tree; `mdstruct` and
    # `mdread` arrive as a git dependency that `fetchCargoVendor` resolves.
    workspaceFiles = lib.fileset.unions [
      ./Cargo.toml
      ./Cargo.lock
      ./vault-query/Cargo.toml
      ./vault-query/src
      ./vault-query/tests
    ];
    # Two files outside the workspace, carried by `vault-query` ALONE: the vault
    # skill's lint rosters. `vault-query/tests/roster.rs` reads them during
    # `checkPhase` and asserts they list exactly the rules `registry::rule_names()`
    # returns, so they have to be in that crate's build sandbox. Listing them file
    # by file rather than naming the skill directory keeps an unrelated skill edit
    # from rebuilding the crate.
    rosterDocs = lib.fileset.unions [
      ./home/agents/skills/vault/SKILL.md
      ./home/agents/skills/vault/references/lint.md
    ];
    # Use cargoHash (fetchCargoVendor) instead of cargoLock.lockFile
    # (importCargoLock). The latter fetches each crate via raw curl, and
    # crates.io's legacy /api/v1 endpoint 403s on curl's default User-Agent.
    # fetchCargoVendor runs `cargo vendor` inside the FOD; cargo's own UA is
    # accepted.
    vault-query = pkgs.rustPlatform.buildRustPackage {
      pname = "vault-query";
      version = "0.1.0";
      src = lib.fileset.toSource {
        root = ./.;
        fileset = lib.fileset.unions [workspaceFiles rosterDocs];
      };
      cargoHash = "sha256-e6PAdFaEyZ+ShQje2P6bcbEafFg5IWdd3Bar4fNEHAs=";
    };
    # The extracted workspace builds as one derivation carrying all three
    # binaries — mdstruct, mdread, mdformat — so comrak compiles once instead of
    # once per crate, and one cargoHash covers the lot.
    md-for-agents = pkgs.rustPlatform.buildRustPackage {
      pname = "md-for-agents";
      version = "0.1.0";
      src = inputs.md-for-agents;
      cargoHash = "sha256-zp/LaWL+VmN6ne+1yQf74bpVICKip6qlVEvy7xFQW0k=";
    };
    # Function to create configuration for any hostname
    mkDarwinConfig = hostname:
      nix-darwin.lib.darwinSystem {
        inherit system;
        specialArgs = {inherit inputs self vault-query md-for-agents hostname;};
        modules = [
          ./hosts/darwin.nix
          nix-homebrew.darwinModules.nix-homebrew
          home-manager.darwinModules.home-manager
          (import ./home {
            username = "vadim";
            homeDirectory = "/Users/vadim";
            inherit vault-query md-for-agents;
          })
        ];
      };
  in {
    # Generate configuration for common hostnames
    darwinConfigurations = {
      default = mkDarwinConfig "default";
      vdrn-studio = mkDarwinConfig "vdrn-studio";
      vdrn-mbp = mkDarwinConfig "vdrn-mbp";
    };

    darwinPackages = self.darwinConfigurations.default.pkgs;
    packages.${system} = {inherit vault-query md-for-agents;};
    formatter.${system} = pkgs.alejandra;
  };
}
