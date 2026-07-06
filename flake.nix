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
    # Use cargoHash (fetchCargoVendor) instead of cargoLock.lockFile
    # (importCargoLock). The latter fetches each crate via raw curl, and
    # crates.io's legacy /api/v1 endpoint 403s on curl's default User-Agent.
    # fetchCargoVendor runs `cargo vendor` inside the FOD; cargo's own UA is
    # accepted.
    vault-query = pkgs.rustPlatform.buildRustPackage {
      pname = "vault-query";
      version = "0.1.0";
      src = ./vault-query;
      cargoHash = "sha256-yAjiNHuZm3TDMTzk2TYnBGv5+vsn6gFaNbmg6HcWEmo=";
    };
    mdstruct = pkgs.rustPlatform.buildRustPackage {
      pname = "mdstruct";
      version = "0.1.0";
      src = ./mdstruct;
      cargoHash = "sha256-tVsDf7y3MQD8BEiWNg8NQtWnjxVgyiE5wCwYiBAZlYA=";
    };
    # Function to create configuration for any hostname
    mkDarwinConfig = hostname:
      nix-darwin.lib.darwinSystem {
        inherit system;
        specialArgs = {inherit inputs self vault-query mdstruct hostname;};
        modules = [
          ./hosts/darwin.nix
          nix-homebrew.darwinModules.nix-homebrew
          home-manager.darwinModules.home-manager
          (import ./home {
            username = "vadim";
            homeDirectory = "/Users/vadim";
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
    formatter.${system} = pkgs.alejandra;
  };
}
