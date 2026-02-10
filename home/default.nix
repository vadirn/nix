{
  username,
  homeDirectory,
  ...
}: {
  users.users.vadim.home = homeDirectory;
  home-manager = {
    useGlobalPkgs = true;
    useUserPackages = true;
    backupFileExtension = "beforeHomeManager";
    users.vadim = {pkgs, config, ...}: {
      home = {
        username = username;
        stateVersion = "24.11";
        packages = with pkgs; [
          ripgrep
          fd
          pass
          jq
          tree
          bat
          btop
          lazygit
          delta
          ngrok
        ];
      };
      programs = {
        home-manager = {
          enable = true;
        };
        fzf = {
          enable = true;
          enableZshIntegration = true;
          enableBashIntegration = true;
        };
        direnv = {
          enable = true;
          enableZshIntegration = true;
          nix-direnv.enable = true;
        };
        zoxide = {
          enable = true;
          enableZshIntegration = false;
        };
        eza = {
          enable = true;
          enableZshIntegration = true;
        };
      };
      home.file.".claude/settings.json".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/claude/settings.json";
      home.file.".claude/CLAUDE.md".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/claude/CLAUDE.md";
      home.file.".config/ghostty/config".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/ghostty-config";
      imports = [
        ./zsh.nix
        ./tmux.nix
        ./git.nix
        ./starship.nix
        ./yazi.nix
      ];
    };
  };
}
