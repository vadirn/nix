{
  description = "Darwin system flake";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs";
    nix-darwin.url = "github:LnL7/nix-darwin";
    nix-darwin.inputs.nixpkgs.follows = "nixpkgs";
    nix-homebrew.url = "github:zhaofengli-wip/nix-homebrew";
    home-manager.url = "github:nix-community/home-manager";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";
    alejandra.url = "github:kamadorueda/alejandra/3.0.0";
    alejandra.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = inputs @ {
    self,
    nixpkgs,
    nix-darwin,
    nix-homebrew,
    home-manager,
    alejandra,
  }: let
    system = "aarch64-darwin";
    configuration = {pkgs, ...}: {
      nixpkgs.config.allowUnfree = true;

      environment.systemPackages = [
        pkgs.git
        pkgs.git-lfs
        pkgs.obsidian
        pkgs.iina
        pkgs.yazi
        pkgs.alejandra
        pkgs.nixd
        pkgs.nodejs
      ];

      homebrew = {
        enable = true;
        taps = [
          "raggi/ale"
        ];
        brews = [
          "ffmpeg"
          "yt-dlp"
          "gnupg"
          "qmk/qmk/qmk"
          "pinentry-mac"
          "reattach-to-user-namespace"
          "openssl-osx-ca"
          "zoxide"
        ];
        casks = [
          "raycast"
          "imageoptim"
          "qmk-toolbox"
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
          "/Applications/Yandex Music.app"
          "/System/Volumes/Preboot/Cryptexes/App/System/Applications/Safari.app"
          "/System/Applications/Mail.app"
          "/System/Applications/Calendar.app"
          "/System/Applications/Reminders.app"
          "/Applications/Claude.app"
          "/Applications/MacWhisper.app"
          "${pkgs.obsidian}/Applications/Obsidian.app"
          "/Applications/Cursor.app"
          "/Applications/Ghostty.app"
          "/Applications/OrbStack.app"
        ];
        dock.tilesize = 72;
        finder.FXPreferredViewStyle = "clmv";
        loginwindow.GuestEnabled = false;
        NSGlobalDomain.AppleICUForce24HourTime = true;
        dock.mru-spaces = false;
        dock.expose-group-apps = true;
      };

      nix.settings.experimental-features = "nix-command flakes";
      programs.zsh.enable = true;
      system.configurationRevision = self.rev or self.dirtyRev or null;
      system.stateVersion = 5;
      system.primaryUser = "vadim";
    };

    homeConfiguration = import ./home {
      username = "vadim";
      homeDirectory = "/Users/vadim";
    };
  in {
    darwinConfigurations.studio = nix-darwin.lib.darwinSystem {
      system = "aarch64-darwin";
      modules = [
        configuration
        nix-homebrew.darwinModules.nix-homebrew
        {
          nix-homebrew = {
            enable = true;
            enableRosetta = true;
            user = "vadim";
          };
        }
        home-manager.darwinModules.home-manager
        homeConfiguration
      ];
    };
    darwinPackages = self.darwinConfigurations.studio.pkgs;
    formatter.aarch64-darwin = nixpkgs.legacyPackages.${system}.alejandra;
  };
}
