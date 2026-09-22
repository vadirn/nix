{
  pkgs,
  lib,
  config,
  self,
  inputs,
  hostname,
  ...
}: {
  networking.hostName = hostname;

  nixpkgs.config.allowUnfree = true;

  environment.systemPackages = with pkgs; [
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
  ];

  environment.systemPath = [
    "/nix/var/nix/profiles/system/sw/bin"
  ];

  # Minimal fix for nix-daemon service - just override the daemon path
  # nix-daemon is managed automatically when nix.enable is true (default)
  launchd.daemons.nix-daemon.command = lib.mkForce "/nix/var/nix/profiles/default/bin/nix-daemon";

  homebrew = {
    enable = true;
    # `trusted = true` emits `tap "...", trusted: true` in the Brewfile.
    # Homebrew 6 (HOMEBREW_REQUIRE_TAP_TRUST) refuses to load formulae/casks
    # from untrusted non-official taps, and `brew bundle`'s zap cleanup loads
    # every installed formula to compute what to remove -- so an untrusted tap
    # aborts activation. Declaring trust in the Brewfile makes `brew bundle`
    # grant it during install and keep it through its trust-store rewrite.
    taps = map (name: {
      inherit name;
      trusted = true;
    }) (builtins.attrNames config.nix-homebrew.taps);
    brews = [
      "git"
      "git-absorb"
      "git-lfs"
      "gh"
      "ffmpeg"
      "yt-dlp"
      "openssl-osx-ca"
      "syncthing"
      "nmap"

      "doppler"
      "glow"
      "gum"
      "hyperfine"
      "jscpd"
      "micro"
      "tealdeer"
      "arimxyer/tap/models"
      "oven-sh/bun/bun"
      "anomalyco/tap/opencode-v2"
      "portless"
    ];
    casks = [
      "1password-cli"
      "codex"
      "iina"
      "raycast"
      "imageoptim"
      "firefox"
      "ghostty"
      "zed"
      "pearcleaner"
      "orbstack"
      "openlogi"
      "basecamp/tap/basecamp-cli"
    ];
    onActivation = {
      cleanup = "zap";
      autoUpdate = true;
      upgrade = true;
      # Skip the interactive "uninstall these?" confirmation during `brew
      # bundle --zap --force-cleanup`; answer is always yes.
      extraFlags = ["--force"];
    };
  };

  system.defaults = {
    dock.autohide = true;
    dock.persistent-apps = [
      "/Applications/Ghostty.app"
      "/Applications/Claude.app"
      "/Applications/ChatGPT.app"
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
    enableRosetta = false;
    user = "vadim";
    mutableTaps = false;
    taps = {
      "arimxyer/homebrew-tap" = inputs.homebrew-arimxyer-tap;
      "oven-sh/homebrew-bun" = inputs.homebrew-oven-sh-bun;
      "anomalyco/homebrew-tap" = inputs.homebrew-anomalyco-tap;
      "basecamp/homebrew-tap" = inputs.homebrew-basecamp-tap;
    };
  };
}
