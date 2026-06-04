{
  description = "Darwin system flake";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
    nix-darwin.url = "github:LnL7/nix-darwin/nix-darwin-25.11";
    nix-darwin.inputs.nixpkgs.follows = "nixpkgs";
    nix-homebrew = {
      url = "github:zhaofengli-wip/nix-homebrew/aeb2069920";
      inputs.brew-src.url = "github:Homebrew/brew/5.1.10";
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
    # Use cargoHash (fetchCargoVendor) instead of cargoLock.lockFile
    # (importCargoLock). The latter fetches each crate via raw curl, and
    # crates.io's legacy /api/v1 endpoint 403s on curl's default User-Agent.
    # fetchCargoVendor runs `cargo vendor` inside the FOD; cargo's own UA is
    # accepted.
    vault-query = nixpkgs.legacyPackages.${system}.rustPlatform.buildRustPackage {
      pname = "vault-query";
      version = "0.1.0";
      src = ./vault-query;
      cargoHash = "sha256-yAjiNHuZm3TDMTzk2TYnBGv5+vsn6gFaNbmg6HcWEmo=";
    };
    # Function to create configuration for any hostname
    mkDarwinConfig = hostname:
      nix-darwin.lib.darwinSystem {
        system = "aarch64-darwin";
        modules = [
          ({
            pkgs,
            lib,
            ...
          }: {
            nixpkgs.config.allowUnfree = true;

            environment.systemPackages =
              (with pkgs; [
                yazi
                alejandra
                nixd
                nodejs
                curl
                typst
                uv
                coreutils
                delta
                check-jsonschema
              ])
              ++ [
                vault-query
              ];

            environment.systemPath = [
              "/nix/var/nix/profiles/system/sw/bin"
            ];

            # Minimal fix for nix-daemon service - just override the daemon path
            # nix-daemon is managed automatically when nix.enable is true (default)
            launchd.daemons.nix-daemon.command = lib.mkForce "/nix/var/nix/profiles/default/bin/nix-daemon";

            homebrew = {
              enable = true;
              brews = [
                "git"
                "git-absorb"
                "git-lfs"
                "gh"
                "ffmpeg"
                "yt-dlp"
                "openssl-osx-ca"
                "syncthing"

                "dopplerhq/cli/doppler"
                "micro"
                "rustup"
                "zig"
                "arimxyer/tap/models"
                "oven-sh/bun/bun"
                "agent-browser"
                "anomalyco/tap/opencode"
                "portless"
              ];
              casks = [
                "1password-cli"
                "iina"
                "raycast"
                "imageoptim"
                "firefox"
                "ghostty"
                "zed"
                "pearcleaner"
                "orbstack"
                "basecamp/tap/basecamp-cli"
              ];
              onActivation = {
                cleanup = "zap";
                autoUpdate = true;
                upgrade = true;
              };
            };

            system.defaults = {
              dock.autohide = true;
              dock.persistent-apps = [
                "/Applications/Ghostty.app"
                "/Applications/Claude.app"
                "/Applications/MacWhisper.app"
                "/Applications/OrbStack.app"
                "/Applications/Obsidian.app"
                "/System/Volumes/Preboot/Cryptexes/App/System/Applications/Safari.app"
                "/Applications/BusyCal.app"
                "/System/Applications/Mail.app"
              ];
              dock.tilesize = 72;
              finder.FXPreferredViewStyle = "clmv";
              loginwindow.GuestEnabled = false;
              NSGlobalDomain.AppleICUForce24HourTime = true;
              NSGlobalDomain.ApplePressAndHoldEnabled = false;
              dock.mru-spaces = false;
              dock.expose-group-apps = false;
            };

            nix.settings.experimental-features = "nix-command flakes";
            programs.zsh.enable = true;
            system.configurationRevision = self.rev or self.dirtyRev or null;
            system.stateVersion = 5;
            system.primaryUser = "vadim";
          })
          nix-homebrew.darwinModules.nix-homebrew
          {
            nix-homebrew = {
              enable = true;
              enableRosetta = true;
              user = "vadim";
              mutableTaps = false;
              taps = {
                "dopplerhq/homebrew-cli" = inputs.homebrew-dopplerhq-cli;
                "arimxyer/homebrew-tap" = inputs.homebrew-arimxyer-tap;
                "oven-sh/homebrew-bun" = inputs.homebrew-oven-sh-bun;
                "anomalyco/homebrew-tap" = inputs.homebrew-anomalyco-tap;
                "basecamp/homebrew-tap" = inputs.homebrew-basecamp-tap;
              };
            };
          }
          ({config, ...}: {
            homebrew.taps = builtins.attrNames config.nix-homebrew.taps;
          })
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
    formatter.aarch64-darwin = nixpkgs.legacyPackages.${system}.alejandra;
  };
}
