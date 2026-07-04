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
    users.vadim = {
      pkgs,
      config,
      ...
    }: {
      home = {
        inherit username;
        stateVersion = "24.11";
        packages = with pkgs; [
          ripgrep
          fd
          pass
          jq
          tree
          btop
          delta
          ngrok
          ruby
          ast-grep
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
          defaultCommand = "rg --files --hidden --glob '!.git'";
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
      home.file.".bunfig.toml".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/bun/bunfig.toml";
      # Global oxfmt config. The post-tool-format hook's universal fallback runs
      # bare `oxfmt <file>`, which walks up from the file's dir (crossing .git
      # boundaries) to discover the nearest .oxfmtrc.json — so this ~ copy governs
      # every fallback-formatted file under $HOME that has no closer config.
      # proseWrap: never collapses each markdown paragraph onto a single line.
      home.file.".oxfmtrc.json".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/bun/oxfmtrc.json";

      imports = [
        ./zsh.nix
        ./tmux.nix
        ./git.nix
        ./starship.nix
        ./yazi.nix
        ./nvim/nvim.nix
        ./bat.nix
        ./glow.nix
        ./claude.nix
        ./ghostty.nix
        ./lazygit.nix
        ./micro.nix
      ];
    };
  };
}
