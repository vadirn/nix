{config, ...}: let
  homeDirectory = config.home.homeDirectory;
in {
  programs.neovim = {
    enable = true;
    vimAlias = true;
    # home-manager auto-generates `$XDG_CONFIG_HOME/nvim/init.lua` from its
    # "advised plugin config" (ruby/python3 host progs, node/perl provider
    # disables). That collides with the out-of-store `~/.config/nvim` symlink
    # below: home-manager 26.05 added a guard that rejects installing a file
    # whose realpath escapes $HOME, and writing init.lua *through* the symlink
    # resolves into the repo, tripping it. `sideloadInitLua` injects that
    # advised config via the wrapper's `--cmd` instead of the file, so the
    # symlinked config (with its own init.lua) is left untouched.
    sideloadInitLua = true;
  };
  xdg.configFile."nvim".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/nvim/config";
}
