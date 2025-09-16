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
    users.vadim = {pkgs, ...}: {
      home = {
        username = username;
        stateVersion = "24.11";
        packages = with pkgs; [
          ripgrep
          fd
          pass
          jq
          tree
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
      };
      imports = [
        ./zsh.nix
        ./tmux.nix
      ];
    };
  };
}
