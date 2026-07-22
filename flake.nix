{
  description = "Darwin system flake";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
    nix-darwin.url = "github:LnL7/nix-darwin/nix-darwin-25.11";
    nix-darwin.inputs.nixpkgs.follows = "nixpkgs";
    nix-homebrew = {
      url = "github:zhaofengli/nix-homebrew/de7953a0";
      inputs.brew-src.url = "github:Homebrew/brew/6.0.5";
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
    # The three crates form one cargo workspace (root `Cargo.toml`), chained by
    # path dependency: vault-query → mdread → mdstruct. Every build source must
    # therefore carry the workspace manifest, the single lockfile, and ALL the
    # member trees at their relative layout. Pin the source to manifests, sources,
    # and tests only (no `target/`) so the input is stable.
    crateSrc = lib.fileset.toSource {
      root = ./.;
      fileset = lib.fileset.unions [
        ./Cargo.toml
        ./Cargo.lock
        ./mdstruct/Cargo.toml
        ./mdstruct/src
        ./mdread/Cargo.toml
        ./mdread/src
        ./vault-query/Cargo.toml
        ./vault-query/src
        ./vault-query/tests
      ];
    };
    # One lockfile vendors one dependency set, so all three packages share a
    # single hash — recompute it here, once, whenever a dependency changes.
    #
    # Use cargoHash (fetchCargoVendor) instead of cargoLock.lockFile
    # (importCargoLock). The latter fetches each crate via raw curl, and
    # crates.io's legacy /api/v1 endpoint 403s on curl's default User-Agent.
    # fetchCargoVendor runs `cargo vendor` inside the FOD; cargo's own UA is
    # accepted.
    workspaceCargoHash = "sha256-fp2iiM18TVXnQPMNp5/JZqDJGrEQPNOcPUPwthitzBM=";
    # Each member builds from the whole workspace tree and is selected by
    # `buildAndTestSubdir`; cargo finds the root manifest above it and builds
    # just that package. The subdirectory is the package name for all three.
    mkCrate = pname:
      pkgs.rustPlatform.buildRustPackage {
        inherit pname;
        version = "0.1.0";
        src = crateSrc;
        buildAndTestSubdir = pname;
        cargoHash = workspaceCargoHash;
      };
    vault-query = mkCrate "vault-query";
    mdread = mkCrate "mdread";
    mdstruct = mkCrate "mdstruct";
    # Function to create configuration for any hostname
    mkDarwinConfig = hostname:
      nix-darwin.lib.darwinSystem {
        inherit system;
        specialArgs = {inherit inputs self vault-query mdread mdstruct hostname;};
        modules = [
          ./hosts/darwin.nix
          nix-homebrew.darwinModules.nix-homebrew
          home-manager.darwinModules.home-manager
          (import ./home {
            username = "vadim";
            homeDirectory = "/Users/vadim";
            inherit vault-query mdread mdstruct;
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
    packages.${system} = {inherit vault-query mdread mdstruct;};
    formatter.${system} = pkgs.alejandra;
  };
}
