{
  description = "Darwin system flake";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
    nix-darwin.url = "github:LnL7/nix-darwin/nix-darwin-25.11";
    nix-darwin.inputs.nixpkgs.follows = "nixpkgs";
    nix-homebrew.url = "github:zhaofengli-wip/nix-homebrew/aeb2069920";
    home-manager.url = "github:nix-community/home-manager/release-25.11";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = inputs @ {
    self,
    nixpkgs,
    nix-darwin,
    nix-homebrew,
    home-manager,
  }: let
    system = "aarch64-darwin";
    vault-query = nixpkgs.legacyPackages.${system}.rustPlatform.buildRustPackage {
      pname = "vault-query";
      version = "0.1.0";
      src = ./vault-query;
      cargoLock.lockFile = ./vault-query/Cargo.lock;
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
                "neovim"
                "oven-sh/bun/bun"
                "agent-browser"
                "anomalyco/tap/opencode"
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
                "codex"
                "codex-app"
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
                "/Applications/Codex.app"
                "/Applications/Gemini.app"
                "/Applications/MacWhisper.app"
                "/Applications/OrbStack.app"
                "/Applications/Obsidian.app"
                "/System/Volumes/Preboot/Cryptexes/App/System/Applications/Safari.app"
                "/System/Applications/Calendar.app"
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
              extraEnv = {
                HOMEBREW_NO_INSTALL_FROM_API = "1";
              };
            };
          }
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
