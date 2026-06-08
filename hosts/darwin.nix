{
  pkgs,
  lib,
  config,
  self,
  vault-query,
  inputs,
  hostname,
  ...
}: {
  networking.hostName = hostname;

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
    taps = builtins.attrNames config.nix-homebrew.taps;
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
