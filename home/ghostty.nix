{config, ...}: let
  homeDirectory = config.home.homeDirectory;
in {
  xdg.configFile."ghostty/config".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/ghostty-config";
}
