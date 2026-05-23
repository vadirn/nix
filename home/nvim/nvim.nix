{config, ...}: let
  homeDirectory = config.home.homeDirectory;
in {
  programs.neovim = {
    enable = true;
    vimAlias = true;
  };
  home.file.".config/nvim".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/nvim/config";
}
