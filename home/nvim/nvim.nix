{config, ...}: let
  homeDirectory = config.home.homeDirectory;
in {
  programs.neovim = {
    enable = true;
    vimAlias = true;
  };
  xdg.configFile."nvim".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/nvim/config";
}
