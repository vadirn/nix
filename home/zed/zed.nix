{config, ...}: let
  homeDirectory = config.home.homeDirectory;
in {
  xdg.configFile."zed/settings.json".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/zed/settings.json";
  xdg.configFile."zed/keymap.json".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/zed/keymap.json";
}
