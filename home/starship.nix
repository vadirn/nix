{config, ...}: let
  homeDirectory = config.home.homeDirectory;
in {
  programs.starship = {
    enable = true;
    enableZshIntegration = true;
  };
  xdg.configFile."starship.toml".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/starship.toml";
}
