{config, ...}: let
  homeDirectory = config.home.homeDirectory;
in {
  # Codex's hooks, as Claude Code's: hooks.json hands every event to route
  # (`route --harness codex <Event>`, generated from the handler list below),
  # and route runs the handlers listed in route/hooks.json. Both are linked out
  # of the store, so an edit takes effect without a rebuild.
  home.file.".codex/hooks.json".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/codex/hooks.json";
  xdg.configFile."route/codex/hooks.json".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/codex/route/hooks.json";
}
