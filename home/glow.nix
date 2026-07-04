{config, ...}: let
  homeDirectory = config.home.homeDirectory;
in {
  xdg.configFile."glow/glow.yml".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/glow.yml";
}
