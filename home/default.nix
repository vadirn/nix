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
        zsh = {
          enable = true;
          enableAutosuggestions = true;
          oh-my-zsh = {
            enable = true;
            plugins = [
              "git"
            ];
          };
        };
        fzf = {
          enable = true;
          enableZshIntegration = true;
        };
        direnv = {
          enable = true;
          nix-direnv.enable = true;
        };
      };
    };
  };
}
