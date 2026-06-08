{config, ...}: let
  homeDirectory = config.home.homeDirectory;
in {
  programs.lazygit = {
    enable = true;
    enableZshIntegration = false;
  };
  xdg.configFile."lazygit/config.yml".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/lazygit-config.yml";
  xdg.configFile."lazygit/light.yml".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/lazygit-light.yml";
}
