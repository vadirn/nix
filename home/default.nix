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
    users.vadim = {...}: {
      home = {
        username = username;
        stateVersion = "24.11";
      };
      programs = {
        home-manager = {
          enable = true;
        };
        fzf = {
          enable = true;
          enableZshIntegration = true;
        };
        direnv = {
          enable = true;
          enableZshIntegration = true;
          nix-direnv.enable = true;
        };
        git = {
          enable = true;
        };
      };
      imports = [
        ./zsh.nix
        ./tmux.nix
      ];
    };
  };
}
