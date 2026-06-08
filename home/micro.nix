{config, ...}: let
  homeDirectory = config.home.homeDirectory;
in {
  xdg.configFile."micro/settings.json".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/micro-settings.json";
  xdg.configFile."micro/bindings.json".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/micro-bindings.json";
}
