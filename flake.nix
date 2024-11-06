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
        pkgs.obsidian
        pkgs.iina
        pkgs.nil
        pkgs.alejandra
      ];

      homebrew = {
        enable = true;
        brews = [
          "mas"
          "ffmpeg"
          "yt-dlp"
          "gnupg"
          "qmk/qmk/qmk"
          "pinentry-mac"
          "reattach-to-user-namespace"
        ];
        casks = ["raycast" "imageoptim" "qmk-toolbox" "firefox"];
        masApps = {};
        onActivation = {
          cleanup = "zap";
          autoUpdate = true;
          upgrade = true;
        };
      };

      system.defaults = {
        dock.autohide = true;
        finder.FXPreferredViewStyle = "clmv";
        loginwindow.GuestEnabled = false;
        NSGlobalDomain.AppleICUForce24HourTime = true;
      };

      services.nix-daemon.enable = true;
      nix.settings.experimental-features = "nix-command flakes";
      programs.zsh.enable = true;
      system.configurationRevision = self.rev or self.dirtyRev or null;
      system.stateVersion = 5;
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
