{
  description = "Darwin system flake";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";
    nix-darwin.url = "github:LnL7/nix-darwin/nix-darwin-25.05";
    nix-darwin.inputs.nixpkgs.follows = "nixpkgs";
    nix-homebrew.url = "github:zhaofengli-wip/nix-homebrew";
    home-manager.url = "github:nix-community/home-manager/release-25.05";
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

            environment.systemPackages = with pkgs; [
              yazi
              alejandra
              nixd
              nodejs
              curl
              bun
              typst
              uv
              poppler_utils
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
                "git-lfs"
                "gh"
                "ffmpeg"
                "yt-dlp"
                "gnupg"
                "pinentry-mac"
                "reattach-to-user-namespace"
                "openssl-osx-ca"
                "syncthing"
                "tw93/tap/mole"
                "dopplerhq/cli/doppler"
                "micro"
              ];
              casks = [
                "1password-cli"
                "obsidian"
                "iina"
                "raycast"
                "imageoptim"
                "firefox"
                "ghostty"
                "zed"
                "pearcleaner"
                "orbstack"

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
                "/Applications/Obsidian.app"
                "/System/Volumes/Preboot/Cryptexes/App/System/Applications/Safari.app"
                "/System/Applications/Calendar.app"
                "/System/Applications/Mail.app"
                "/Applications/OrbStack.app"
              ];
              dock.tilesize = 72;
              finder.FXPreferredViewStyle = "clmv";
              loginwindow.GuestEnabled = false;
              NSGlobalDomain.AppleICUForce24HourTime = true;
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
