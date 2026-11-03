{
  config,
  pkgs,
  ...
}: let
  homeDirectory = config.home.homeDirectory;
in {
  programs.lazygit = {
    enable = true;
    enableZshIntegration = false;
    # nixos-26.05 ships 0.61.1, which overflows its stack when two worktrees
    # share a path. 0.66.2 fixes that (jesseduffield/lazygit#6129). Drop this
    # override once the flake moves to 26.11.
    package = pkgs.lazygit.overrideAttrs (finalAttrs: _: {
      version = "0.66.2";
      src = pkgs.fetchFromGitHub {
        owner = "jesseduffield";
        repo = "lazygit";
        tag = "v${finalAttrs.version}";
        hash = "sha256-ZjbaMLHUInTe9heLfQxnU4+rBqZry1ciENJXqpvq9rU=";
      };
    });
  };
  xdg.configFile."lazygit/config.yml".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/lazygit-config.yml";
  xdg.configFile."lazygit/light.yml".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/lazygit-light.yml";
}
