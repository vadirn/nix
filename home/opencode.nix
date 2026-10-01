{config, ...}: let
  homeDirectory = config.home.homeDirectory;
in {
  home.file.".config/opencode/opencode.json".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/opencode/opencode.json";
  home.file.".config/opencode/AGENTS.md".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/agents/AGENTS.md";
}
